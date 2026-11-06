"""Static structure only: no network, script execution, source text or URL publication."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit

APPROVED=frozenset({'hgplaycdn.com','hglamioz.com','niramirus.com','playnixes.com','medixiru.com'})

def authorized(host,summary):
    lists=summary.get('lists',{}) if isinstance(summary,dict) else {}
    return host in APPROVED and isinstance(lists,dict) and host in lists.get('dmca',[])

def host_only(value,base):
    try:
        p=urlsplit(urljoin(base,value))
        if p.scheme!='https' or p.username or p.password or p.port not in(None,443):return 'redacted'
        h=p.hostname or ''
        if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}',h):return 'redacted'
        if h.endswith(('.local','.localhost','.internal','.test','.invalid','.example')):return 'redacted'
        return h
    except Exception:return 'redacted'

def signals(text):
    patterns={
        'jwplayer':r'\bjwplayer\s*\(', 'playerjs':r'\bPlayerjs\s*\(',
        'videojs':r'\bvideojs\s*\(', 'clappr':r'\bClappr\b',
        'hlsjs':r'\bHls\s*\(', 'shaka':r'\bshaka\s*\.',
        'plyr':r'\bPlyr\s*\(', 'setup_call':r'\.setup\s*\(',
        'eval_function':r'\beval\s*\(\s*function\b', 'atob_call':r'\batob\s*\(',
        'json_parse':r'\bJSON\s*\.\s*parse\s*\(', 'fetch_call':r'\bfetch\s*\(',
        'xml_http_request':r'\bXMLHttpRequest\b', 'crypto_js':r'\bCryptoJS\b',
        'web_crypto':r'\bcrypto\s*\.\s*subtle\b', 'hls_suffix':r'\.m3u8\b',
        'dash_suffix':r'\.mpd\b', 'mp4_suffix':r'\.mp4\b',
        'file_property':r"""(?:\bfile|["']file["'])\s*:""",
        'sources_property':r"""(?:\bsources|["']sources["'])\s*:""",
        'source_property':r"""(?:\bsrc|["']src["'])\s*:""",
        'captcha_marker':r'\bcaptcha\b', 'cloudflare_challenge_marker':r'cf-chl-|challenge-platform',
        'file_missing_marker':r'file\s+(?:was\s+)?(?:not\s+found|deleted|removed)'
    }
    return {key:bool(re.search(pattern,text,re.I)) for key,pattern in patterns.items()}

def packed_summary(text):
    if len(text)>200000:return {'status':'packed_input_limit'}
    try:
        parser=Path(__file__).with_name('instrument_routing.cjs')
        result=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(parser),'--inspect-packed'],input=text,text=True,capture_output=True,timeout=5)
        if result.returncode or len(result.stdout)>6000000:return {'status':'packed_parser_failed_or_limit'}
        data=json.loads(result.stdout)
        if data.get('status')!='packed_inspection_complete':return {'status':'packed_parser_failed_or_limit'}
        output=[]
        allowed={'decoded_candidate','unsupported_wrapper','nonliteral_arguments','data_limits_rejected','dictionary_count_mismatch','decoded_output_limit'}
        for candidate in data.get('candidates',[])[:4]:
            status=candidate.get('status');item={'status':status if status in allowed else 'unsupported_wrapper'}
            for key in ('parameter_count','radix','word_count'):
                value=candidate.get(key)
                if isinstance(value,int) and 0<=value<=10000:item[key]=value
            decoded=candidate.get('decoded')
            if status=='decoded_candidate' and isinstance(decoded,str):
                item['characters']=len(decoded);item['sha256']=hashlib.sha256(decoded.encode('utf-8')).hexdigest();item['signals']=signals(decoded)
            output.append(item)
        return {'status':'packed_inspection_complete','candidates':output,
                'legacy_parameter_signature':bool(re.search(r'eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)',text)),
                'legacy_countdown_signature':bool(re.search(r'while\s*\(\s*c--\s*\)',text)),
                'note':'Literal dictionary-substitution candidates only; not evaluated function output. Decoded source and links are never published or executed.'}
    except Exception:return {'status':'packed_parser_failed_or_limit'}

class Structure(HTMLParser):
    def __init__(self,base):
        super().__init__(convert_charrefs=True)
        self.base=base;self.tags={key:0 for key in ('script','iframe','video','source','form')};self.scripts=[];self.active=None;self.external=0;self.inline=0;self.media=[];self.truncated=False
    def handle_starttag(self,tag,attrs):
        tag=tag.lower();a=dict(attrs)
        if tag in self.tags:self.tags[tag]+=1
        if tag=='script':
            self.external+=bool(a.get('src'));self.inline+=not bool(a.get('src'))
            self.active=None
            if len(self.scripts)>=40:self.truncated=True;return
            raw_type=(a.get('type') or '').lower()
            item={'index':self.tags['script'],'external':bool(a.get('src')),'type':'module' if raw_type=='module' else 'json' if 'json' in raw_type else 'javascript_or_unspecified','integrity_present':bool(a.get('integrity')),'characters':0,'chunks':[]}
            if a.get('src'):item['host']=host_only(a['src'],self.base)
            self.scripts.append(item);self.active=item
        elif tag in ('video','source') and a.get('src'):
            if len(self.media)<20:self.media.append({'tag':tag,'host':host_only(a['src'],self.base),'signals':signals(a['src'])})
            else:self.truncated=True
    def handle_endtag(self,tag):
        if tag.lower()=='script':self.active=None
    def handle_data(self,data):
        if self.active is not None:self.active['chunks'].append(data);self.active['characters']+=len(data)

def inspect(html,base):
    if len(html)>3000000:return {'status':'input_limit'}
    try:
        parser=Structure(base);parser.feed(html);scripts=[];packed_checks=0
        for item in parser.scripts:
            text=''.join(item.pop('chunks'));item['signals']=signals(text)
            if not item['external']:
                item['inline_sha256']=hashlib.sha256(text.encode('utf-8')).hexdigest()
                if item['signals']['eval_function']:
                    if packed_checks<4:item['packed_inspection']=packed_summary(text);packed_checks+=1
                    else:item['packed_inspection']={'status':'packed_script_limit'}
            scripts.append(item)
        return {'status':'static_structure_complete','html_sha256':hashlib.sha256(html.encode('utf-8')).hexdigest(),
                'tags':parser.tags,'external_script_count':parser.external,'inline_script_count':parser.inline,
                'scripts':scripts,'media_tag_references':parser.media,'document_signals':signals(html),'truncated':parser.truncated,
                'note':'Pattern presence only, not proof of player behavior or an error page. No referenced resource was fetched; no destination script executed. Hosts only; no paths, parameters, raw HTML, script bodies or signed links.'}
    except Exception:return {'status':'static_structure_parse_failed'}

def self_test():
    count=0
    def check(a,b):
        nonlocal count
        assert a==b;count+=1
    html='<script src="/private-loader.js?token=secret"></script><script>jwplayer("secret-id").setup({sources:[{file:"https://cdn.fixture.net/master.m3u8?token=secret"}]});fetch("/api/secret");</script><video><source src="https://cdn.fixture.net/video.mp4?token=secret"></video>'
    report=inspect(html,'https://medixiru.com/e/private-id?token=secret')
    check(report['status'],'static_structure_complete');check(report['tags']['script'],2)
    check(report['scripts'][0]['host'],'medixiru.com');check(report['scripts'][1]['signals']['jwplayer'],True)
    check(report['document_signals']['hls_suffix'],True);check(report['document_signals']['fetch_call'],True)
    assert all(token not in json.dumps(report) for token in ('secret','private-id','loader.js','https://'));count+=1
    check(host_only('https://127.0.0.1/x','https://medixiru.com/'),'redacted')
    check(inspect('x'*3000001,'https://medixiru.com/')['status'],'input_limit')
    check(authorized('playnixes.com',{'lists':{'dmca':['playnixes.com']}}),True)
    check(authorized('playnixes.com',{'lists':{'dmca':['medixiru.com']}}),False)
    check(authorized('unknown.net',{'lists':{'dmca':['unknown.net']}}),False)
    return {'passed':count,'total':12,'scope':'Synthetic static-inspection, redaction and same-run membership checks only; no network or remote code execution.'}

if __name__=='__main__':print(json.dumps(self_test()))
