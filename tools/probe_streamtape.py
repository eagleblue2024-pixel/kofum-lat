"""Bounded Streamtape probe for Nemo. No JavaScript evaluation or video saving."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlsplit

MOVIE='https://gnula.life/movies/buscando-a-nemo'
HOSTS={'streamtape.com'}
TOKEN=re.compile(r"""\s*(?:(?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?P<number>-?\d{1,5})|(?P<name>substring|slice)|(?P<operator>[+().,]))""")
class ProbeError(Exception):pass

def string_value(token):
    def sub(m):
        s=m[0][1:]
        if s.startswith(('x','u')):return chr(int(s[1:],16))
        return {'n':'\n','r':'\r','t':'\t'}.get(s,s)
    return re.sub(r'\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)',sub,token[1:-1])

class Expression:
    def __init__(self,text):
        self.tokens=[];offset=0
        while offset<len(text):
            if text[offset:].lstrip().startswith(';'):break
            if not text[offset:].strip():break
            match=TOKEN.match(text,offset)
            if not match:raise ProbeError('expression_unsupported')
            self.tokens.append((match.lastgroup,match[match.lastgroup]));offset=match.end()
            if len(self.tokens)>100:raise ProbeError('expression_limit')
        self.index=0
    def take(self,kind=None,value=None):
        if self.index>=len(self.tokens):raise ProbeError('expression_unsupported')
        token=self.tokens[self.index]
        if kind and token[0]!=kind or value and token[1]!=value:raise ProbeError('expression_unsupported')
        self.index+=1;return token[1]
    def peek(self,value):return self.index<len(self.tokens) and self.tokens[self.index][1]==value
    def term(self,depth):
        if depth>8:raise ProbeError('expression_limit')
        if self.peek('('):self.take(value='(');value=self.sum(depth+1);self.take(value=')')
        else:value=string_value(self.take(kind='string'))
        while self.peek('.'):
            self.take(value='.');method=self.take(kind='name');self.take(value='(');start=int(self.take(kind='number'));end=None
            if self.peek(','):self.take(value=',');end=int(self.take(kind='number'))
            self.take(value=')')
            if method=='substring':
                start=max(0,min(len(value),start));end=len(value) if end is None else max(0,min(len(value),end))
                value=value[min(start,end):max(start,end)]
            else:value=value[start:end]
        if len(value)>16000:raise ProbeError('expression_limit')
        return value
    def sum(self,depth=0):
        value=self.term(depth)
        while self.peek('+'):self.take(value='+');value+=self.term(depth)
        if len(value)>16000:raise ProbeError('expression_limit')
        return value
    def parse(self):
        value=self.sum()
        if self.index!=len(self.tokens):raise ProbeError('expression_unsupported')
        return value

def robot_url(html):
    matches=list(re.finditer(r"document\.getElementById\(\s*(['\"])robotlink\1\s*\)\.innerHTML\s*=\s*",html))
    if len(matches)!=1:raise ProbeError('robotlink_not_unique')
    value=Expression(html[matches[0].end():]).parse()
    if value.startswith('//'):value='https:'+value
    p=urlsplit(value)
    if p.scheme!='https' or p.hostname not in HOSTS or p.username or p.password or p.port not in(None,443) or p.path!='/get_video' or not p.query or p.fragment:
        raise ProbeError('video_url_unsupported')
    return value

def post_player(html):
    blocks=re.findall(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html,re.I)
    found=[body for attrs,body in blocks if re.search(r'\bid\s*=\s*["\']__NEXT_DATA__["\']',attrs)]
    if len(found)!=1:raise ProbeError('missing_next_data')
    p=json.loads(found[0])['props']['pageProps']['post']
    if p.get('IMDbId')!='tt0266543' or str(p.get('TMDbId'))!='12':raise ProbeError('movie_mismatch')
    rows=[x for x in p.get('players',{}).get('latino',[]) if x.get('cyberlocker')=='streamtape']
    if len(rows)!=1:raise ProbeError('streamtape_not_unique')
    url=rows[0].get('result','')
    if not re.fullmatch(r'https://player\.gnula\.life/player\.php\?h=[A-Za-z0-9_.~-]+',url):raise ProbeError('invalid_intermediate')
    return url

def embed_url(html):
    found=re.findall(r"\bvar\s+url\s*=\s*(['\"])([^'\"\r\n]+)\1\s*;",html)
    values=sorted({value.replace('\\/','/').replace('&amp;','&') for _,value in found})
    if len(values)!=1:raise ProbeError('embed_not_unique')
    p=urlsplit(values[0])
    if p.scheme!='https' or p.hostname not in HOSTS or p.username or p.password or p.port not in(None,443):raise ProbeError('embed_host_unsupported')
    return values[0]

def binary_probe(url,referer,events):
    import analyze_mainjs as base
    for attempt in range(3):
        p=urlsplit(url);base.checked_url(url,{p.hostname})
        connection=base.PinnedHTTPS(p.hostname,timeout=12)
        try:
            path=(p.path or '/')+('?' + p.query if p.query else '')
            connection.request('GET',path,headers={'User-Agent':base.UA,'Referer':referer,'Range':'bytes=0-1023','Accept-Encoding':'identity'})
            response=connection.getresponse()
            events.append({'stage':'video_probe','http_status':response.status,'host':p.hostname})
            if response.status in(301,302,303,307,308):
                destination=response.getheader('Location')
                if not destination:raise ProbeError('redirect_without_location')
                url=urljoin(url,destination);continue
            if response.status not in(200,206):raise ProbeError('video_http_error')
            sample=response.read(1024)
            mime=response.getheader('Content-Type','').split(';')[0].strip().lower()
            if mime not in('video/mp4','application/octet-stream','application/mp4'):mime='other'
            return{'http_status':response.status,'mime_class':mime,'sample_bytes':len(sample),'mp4_ftyp':sample[4:8]==b'ftyp','note':'Only up to 1024 response-body bytes read; server may ignore Range. No decoding or playback test.'}
        finally:connection.close()
    raise ProbeError('redirect_limit')

def probe(fetch=None,sample=None):
    if fetch is None:
        import analyze_mainjs as base
        fetch=base.fetch_text
    if sample is None:sample=binary_probe
    report={'source':'Gnula Nemo Latino Streamtape','status':'not_completed','events':[]};events=report['events'];stage='movie'
    try:
        html=fetch(MOVIE,{'gnula.life'},'https://gnula.life/',stage,events);middle=post_player(html)
        stage='intermediate';html=fetch(middle,{'player.gnula.life'},MOVIE,stage,events);embed=embed_url(html)
        stage='server';html=fetch(embed,HOSTS,MOVIE,stage,events);url=robot_url(html)
        report['extraction']='restricted_literal_concatenation_only';stage='video_probe';report['video_probe']=sample(url,embed,events)
        report['status']='mp4_signature_observed' if report['video_probe'].get('mp4_ftyp') else 'candidate_not_verified_as_mp4'
    except Exception as error:
        report['status']='unsupported_or_failed';code=str(error) if isinstance(error,ProbeError) else ''
        report['failure']={'stage':stage,'code':code if re.fullmatch(r'[a-z_]+',code) else 'network_or_parse_error'}
    return report

def self_test():
    passed=0
    def check(actual,expected):
        nonlocal passed
        assert actual==expected;passed+=1
    check(Expression("'a' + 'b';").parse(),'ab')
    check(Expression("'a' + ('xcdtail').substring(3);").parse(),'atail')
    check(Expression("'abc'.slice(1);").parse(),'bc')
    check(Expression("'abc'.substring(2,0);").parse(),'ab')
    check(Expression(r"'a\x26b';").parse(),'a&b')
    for expression in("fetch('x');","'a'+evil();","'a'.constructor('x');"):
        try:Expression(expression).parse()
        except ProbeError:passed+=1
        else:raise AssertionError('unsafe expression accepted')
    assignment="document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=video' + ('xx&token=private').substring(2);"
    check(robot_url('<script>'+assignment+'</script>'),'https://streamtape.com/get_video?id=video&token=private')
    try:robot_url("document.getElementById('robotlink').innerHTML = '//other.net/get_video?id=x';")
    except ProbeError:passed+=1
    else:raise AssertionError('other host accepted')
    middle='https://player.gnula.life/player.php?h=fixture';embed='https://streamtape.com/e/test'
    post={'TMDbId':'12','IMDbId':'tt0266543','players':{'latino':[{'cyberlocker':'streamtape','result':middle}]}}
    page='<script id="__NEXT_DATA__">'+json.dumps({'props':{'pageProps':{'post':post}}})+'</script>'
    bodies={MOVIE:page,middle:"<script>var url = '"+embed+"';</script>",embed:'<script>'+assignment+'</script>'}
    def fetch(url,hosts,referer,stage,events):events.append({'stage':stage,'http_status':200});return bodies[url]
    result=probe(fetch,lambda *args:{'mp4_ftyp':True})
    check(result['status'],'mp4_signature_observed')
    serialized=json.dumps(result);assert 'token=' not in serialized and 'private' not in serialized and 'https://' not in serialized;passed+=1
    return{'passed':passed,'total':12,'scope':'Synthetic expressions and mocked requests; no live extraction or playback verified.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(self_test()))
    else:
        path=Path('analysis/streamtape-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(probe(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
