"""Read-only remote-source inspection. Never executes or publishes remote code."""
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

MOVIE = 'https://gnula.life/movies/buscando-a-nemo'
FALLBACK = 'https://player.gnula.life/player.php?h=rxPRsRSX4IlkyS1F21W5j7yEF5hgjp3WNStwp3OXnZ.xhDGbxZHrdMxAz.9D9fiL'
EMBED_HOSTS = {'streamwish.com','streamwish.to','niramirus.com','medixiru.com','hanerix.com','hglink.to','hgcloud.to'}
UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'
LIMIT = 3000000
STRINGS = re.compile(r""""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'""")

class AnalysisError(Exception):
    pass


def checked_url(url, hosts):
    p = urlsplit(url)
    if p.scheme != 'https' or p.hostname not in hosts or p.username or p.password or p.port not in (None,443) or p.fragment:
        raise AnalysisError('url_not_allowed')
    if any(ord(c) < 33 or ord(c) > 126 for c in url):
        raise AnalysisError('url_not_allowed')
    return p


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        answers = socket.getaddrinfo(self.host,443,type=socket.SOCK_STREAM)
        addresses = sorted({answer[4][0] for answer in answers})
        if not addresses or not all(ipaddress.ip_address(ip).is_global for ip in addresses):
            raise AnalysisError('non_public_dns')
        sock = socket.create_connection((addresses[0],443),timeout=self.timeout)
        self.sock = self._context.wrap_socket(sock,server_hostname=self.host)


def fetch_text(url, hosts, referer, stage, events):
    p = checked_url(url,hosts)
    connection = PinnedHTTPS(p.hostname,timeout=12,context=ssl.create_default_context())
    try:
        target = p.path or '/'
        if p.query:
            target += '?' + p.query
        connection.request('GET',target,headers={'User-Agent':UA,'Referer':referer,'Accept-Encoding':'identity'})
        response = connection.getresponse()
        events.append({'stage':stage,'http_status':response.status})
        if response.status < 200 or response.status >= 300:
            raise AnalysisError('http_' + str(response.status))
        body = response.read(LIMIT+1)
        if len(body) > LIMIT:
            raise AnalysisError('response_too_large')
        return body.decode('utf-8',errors='replace')
    finally:
        connection.close()


class ScriptParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts = []
        self.active = None

    def handle_starttag(self,tag,attrs):
        if tag.lower() == 'script':
            self.active = {'attrs':dict(attrs),'chunks':[]}
            self.scripts.append(self.active)

    def handle_data(self,data):
        if self.active is not None:
            self.active['chunks'].append(data)

    def handle_endtag(self,tag):
        if tag.lower() == 'script':
            self.active = None


def scripts_in(html):
    parser = ScriptParser()
    parser.feed(html)
    return parser.scripts


def movie_player(html):
    matches = [s for s in scripts_in(html) if s['attrs'].get('id') == '__NEXT_DATA__']
    if len(matches) != 1:
        raise AnalysisError('missing_next_data')
    post = json.loads(''.join(matches[0]['chunks']))['props']['pageProps']['post']
    if post.get('IMDbId') != 'tt0266543' or str(post.get('TMDbId')) != '12':
        raise AnalysisError('movie_mismatch')
    for player in post.get('players',{}).get('latino',[]):
        if player.get('cyberlocker') == 'streamwish':
            url = player.get('result','')
            checked_url(url,{'player.gnula.life'})
            if not re.fullmatch(r'https://player\.gnula\.life/player\.php\?h=[A-Za-z0-9_.~-]+',url):
                raise AnalysisError('invalid_player_url')
            return url
    raise AnalysisError('missing_streamwish')


def embed_url(html):
    found = []
    for script in scripts_in(html):
        match = re.search(r"\bvar\s+url\s*=\s*(['\"])([^'\"\r\n]+)\1\s*;",''.join(script['chunks']))
        if match:
            found.append(match[2].replace('\\/','/').replace('&amp;','&'))
    found = sorted(set(found))
    if len(found) != 1:
        raise AnalysisError('embed_not_unique')
    checked_url(found[0],EMBED_HOSTS)
    return found[0]


def main_script(html,embed):
    host = urlsplit(embed).hostname
    found = []
    for script in scripts_in(html):
        src = script['attrs'].get('src') or ''
        if re.search(r'(?:^|/)main\.js(?:[?#]|$)',src,re.I):
            url = urljoin(embed,src)
            checked_url(url,{host})
            found.append(url)
    found = sorted(set(found))
    if len(found) != 1:
        raise AnalysisError('main_script_not_unique')
    return found[0]


def decode_string(token):
    def replace(match):
        value = match[0][1:]
        if value.startswith('x') or value.startswith('u'):
            return chr(int(value[1:],16))
        return {'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v'}.get(value,value)
    return re.sub(r'\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)',replace,token[1:-1])


def domain(value):
    h = value.lower()
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}',h):
        return None
    if h.endswith(('.localhost','.local','.internal','.invalid','.example','.test','.js','.json','.m3u8')):
        return None
    return h


def literal_lists(js):
    output = {}
    for name in ('main','dmca','rules'):
        matches = list(re.finditer(r'\b'+name+r'\s*=\s*\[([^\]]{0,20000})\]',js))
        if len(matches) != 1:
            output[name] = {'status':'missing_or_ambiguous'}
            continue
        raw = matches[0][1]
        tokens = list(STRINGS.finditer(raw))
        residue = STRINGS.sub('',raw)
        values = [decode_string(token[0]) for token in tokens]
        if re.sub(r'[,\s]','',residue) or any(domain(v) is None for v in values) or len(values)>100:
            output[name] = {'status':'not_literal_domains'}
        else:
            output[name] = {'status':'literal_domains','domains':values}
    return output


def inspect_script(js):
    tokens = list(STRINGS.finditer(js))
    hosts = set()
    for token in tokens:
        value = decode_string(token[0])
        if domain(value):
            hosts.add(domain(value))
        elif value.startswith(('https://','http://')):
            try:
                h = urlsplit(value).hostname
                if h and domain(h):
                    hosts.add(domain(h))
            except ValueError:
                pass
    return {
        'characters':len(js),
        'sha256_utf8':hashlib.sha256(js.encode('utf-8')).hexdigest(),
        'hex_identifier_count':len(set(re.findall(r'\b_0x[a-f0-9]+\b',js,re.I))),
        'hex_escape_count':len(re.findall(r'\\x[0-9a-f]{2}',js,re.I)),
        'unicode_escape_count':len(re.findall(r'\\u[0-9a-f]{4}',js,re.I)),
        'packed_signature':bool(re.search(r'eval\s*\(\s*function\s*\(p,a,c',js)),
        'atob_signature':bool(re.search(r'\batob\s*\(',js)),
        'array_rotation_indicators':bool(re.search(r'\.push\s*\(',js) and re.search(r'\.shift\s*\(',js)),
        'parse_int_indicator':bool(re.search(r'\bparseInt\s*\(',js)),
        'literal_lists':literal_lists(js),
        'domain_shaped_literals':sorted(hosts)[:60],
        'domain_literals_truncated':len(hosts)>60,
        'domain_note':'Static candidates only. Not verified routing, authorization or playable video sources.'
    }


def safe_code(error):
    code = str(error) if isinstance(error,AnalysisError) else ''
    return code if re.fullmatch(r'[a-z_]+(?:_[0-9]{3})?',code) else 'network_or_parse_error'


def analyze(fetch=fetch_text):
    report = {'status':'not_completed','scope':'Runner-side unauthenticated text inspection; no remote JavaScript execution or playback.','events':[]}
    events = report['events']
    stage = 'movie'
    try:
        try:
            html = fetch(MOVIE,{'gnula.life'},'https://gnula.life/',stage,events)
            player = movie_player(html)
            report['player_origin'] = 'fresh_movie_page'
        except Exception as error:
            events.append({'stage':'movie','error':safe_code(error)})
            player = FALLBACK
            report['player_origin'] = 'fallback_from_user_html_may_be_stale'
        stage = 'intermediate'
        html = fetch(player,{'player.gnula.life'},MOVIE,stage,events)
        embed = embed_url(html)
        stage = 'server'
        html = fetch(embed,EMBED_HOSTS,MOVIE,stage,events)
        report['server_host'] = urlsplit(embed).hostname
        report['server_characters'] = len(html)
        script = main_script(html,embed)
        stage = 'main_script'
        js = fetch(script,{urlsplit(embed).hostname},embed,stage,events)
        report['script'] = inspect_script(js)
        report['status'] = 'static_inspection_complete'
    except Exception as error:
        report['status'] = 'blocked_or_unsupported'
        report['failure'] = {'stage':stage,'code':safe_code(error)}
    return report


if __name__ == '__main__':
    output = Path('analysis/mainjs-report.json')
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(analyze(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
