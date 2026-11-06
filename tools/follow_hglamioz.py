"""Follow only an observed, explicitly approved same-path destination."""
import asyncio
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ORIGINS={'streamwish.com','streamwish.to','niramirus.com','medixiru.com','hanerix.com','hglink.to','hgcloud.to'}
TARGETS=frozenset({'hglamioz.com','medixiru.com'})
STRING=r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"""
PACK=re.compile(r'\}\s*\(\s*('+STRING+r')\s*,\s*(\d{1,2})\s*,\s*(\d{1,5})\s*,\s*('+STRING+r')\s*\.split\(\s*([\'"])\|\5\s*\)')
class ProbeError(Exception):pass

def public_name(host):
    return isinstance(host,str) and bool(re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}',host)) and not host.endswith(('.local','.localhost','.internal','.test','.invalid','.example'))

def safe_https(url,hosts=None):
    if not isinstance(url,str) or len(url)>16000:raise ProbeError('url_not_allowed')
    p=urlsplit(url)
    if p.scheme!='https' or not public_name(p.hostname) or p.username or p.password or p.port not in(None,443) or p.fragment or hosts is not None and p.hostname not in hosts:
        raise ProbeError('url_not_allowed')
    return p

def remember(url,main_navigation,page,state):
    if not main_navigation:return
    try:p=safe_https(url)
    except Exception:return
    if state.get('embed') is None and p.hostname in ORIGINS:
        state['embed']=url;state['page']=page
    elif state.get('embed') and page is state.get('page') and not state.get('destination'):
        original=urlsplit(state['embed'])
        if p.hostname in TARGETS and p.hostname!=original.hostname and p.path==original.path:state['destination']=url

def decode_string(token):
    def replace(m):
        value=m[0][1:]
        if value.startswith(('x','u')):return chr(int(value[1:],16))
        return {'n':'\n','r':'\r','t':'\t'}.get(value,value)
    return re.sub(r'\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)',replace,token[1:-1])

def unpack_one(text):
    if not re.search(r'eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)',text) or not re.search(r'while\s*\(\s*c--\s*\)',text):return None
    matches=list(PACK.finditer(text))
    if len(matches)!=1:raise ProbeError('packed_data_not_unique')
    m=matches[0];payload=decode_string(m[1]);radix=int(m[2]);count=int(m[3]);words=decode_string(m[4]).split('|')
    if not 2<=radix<=62 or not 1<=count<=10000 or len(words)<count or len(payload)>1000000 or sum(map(len,words))>1000000:
        raise ProbeError('packed_data_limit')
    alphabet='0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    expanded=0
    def replace(token):
        nonlocal expanded
        value=0;result=token[0]
        for char in token[0]:
            digit=alphabet.find(char)
            if digit<0 or digit>=radix:break
            value=value*radix+digit
            if value>=count:break
        else:result=words[value] if words[value] else token[0]
        expanded+=len(result)
        if expanded>2000000:raise ProbeError('unpacked_output_limit')
        return result
    return re.sub(r'\b[0-9A-Za-z]+\b',replace,payload)

def source_url(html):
    scripts=[body for _,body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html,re.I)]
    if len(scripts)>40:raise ProbeError('script_limit')
    texts=[];unpacked=0
    for body in scripts:
        texts.append(body)
        for _ in range(2):
            result=unpack_one(body)
            if result is None:break
            unpacked+=1;texts.append(result);body=result
    values=set()
    fields=re.compile(r"""(?:\bfile|\bsrc|["']file["']|["']src["'])\s*:\s*("""+STRING+r')')
    for text in texts:
        for m in fields.finditer(text):
            value=decode_string(m[1]).replace('&amp;','&')
            if re.search(r'\.m3u8(?:[?#]|$)',value,re.I):safe_https(value);values.add(value)
    if len(values)!=1:raise ProbeError('hls_not_found' if not values else 'hls_ambiguous')
    return values.pop(),{'script_blocks':len(scripts),'packed_layers_decoded_as_data':unpacked}

def verify_playlist(url,referer,fetch,events,depth=0):
    if depth>2:raise ProbeError('playlist_depth')
    p=safe_https(url);body=fetch(url,{p.hostname},referer,'destination_hls',events)
    if not re.match(r'\s*#EXTM3U\b',body):raise ProbeError('not_hls')
    lines=body.splitlines();variants=[]
    if len(lines)>10000:raise ProbeError('playlist_line_limit')
    for index,line in enumerate(lines):
        if line.startswith('#EXT-X-STREAM-INF:'):
            resolution=re.search(r'RESOLUTION=\d+x(\d+)',line)
            for child in lines[index+1:]:
                if child and not child.startswith('#'):
                    variants.append((int(resolution[1]) if resolution else 0,urljoin(url,child.strip())))
                    if len(variants)>40:raise ProbeError('variant_limit')
                    break
    if variants:
        height,next_url=max(variants,key=lambda x:x[0]);safe_https(next_url)
        child=verify_playlist(next_url,referer,fetch,events,depth+1)
        return {'kind':'master','variant_count':len(variants),'declared_max_height':height or None,'selected_variant':child,
                'note':'Height declared by the playlist, not measured from decoded video.'}
    entries=sum(line.startswith('#EXTINF:') for line in lines)
    if not entries:raise ProbeError('empty_playlist')
    return {'kind':'media','entry_count':entries,'segments_requested':False}

def validate_destination(url,embed,events,fetch=None):
    report={'status':'not_completed','host':None,'approved_hosts':sorted(TARGETS),'note':'Exact browser-observed URL only; no identifier migration, remote script execution at destination, segment requests or playback test.'}
    errors=(ProbeError,)
    if fetch is None:
        import analyze_mainjs as base
        fetch=base.fetch_text;errors=(ProbeError,base.AnalysisError)
    try:
        p=safe_https(url,TARGETS);original=safe_https(embed,ORIGINS)
        if p.path!=original.path:raise ProbeError('destination_path_changed')
        if p.hostname==original.hostname:raise ProbeError('destination_not_new')
        report['host']=p.hostname
        html=fetch(url,{p.hostname},embed,'destination',events)
        report['html_characters']=len(html)
        report['iframe_count']=len(re.findall(r'<iframe\b',html,re.I))
        hls,stats=source_url(html);report['extraction']=stats
        report['playlist']=verify_playlist(hls,p.scheme+'://'+p.hostname+'/',fetch,events)
        report['status']='hls_playlists_accessible_playback_unverified'
    except Exception as error:
        code=str(error) if isinstance(error,errors) else ''
        report['status']='unsupported_or_failed';report['code']=code if re.fullmatch(r'[a-z_]+(?:_\d{3})?',code) else 'network_or_parse_error'
    return report

async def run():
    private={'embed':None,'destination':None,'page':None};restore=None
    report={'requested_slug':'the-mongoose','status':'destination_probe_setup_failed'}
    try:
        from playwright.async_api import BrowserContext
        import sandbox_launcher as launcher
        original=BrowserContext.route
        async def instrument(self,pattern,handler,*args,**kwargs):
            async def wrapped(route):
                request=route.request
                try:
                    frame=request.frame;page=frame.page
                    remember(request.url,request.method=='GET' and request.is_navigation_request() and frame==page.main_frame,page,private)
                except Exception:pass
                await handler(route)
            return await original(self,pattern,wrapped,*args,**kwargs)
        BrowserContext.route=instrument
        def restore_route():BrowserContext.route=original
        restore=restore_route
        report=await launcher.run()
    except Exception:
        report['destination_probe_error']='browser_observation_failed'
    finally:
        if restore:restore()
    report['additional_scope']='After closing Chromium, fetch only the exact observed HTTPS destination on hglamioz.com or medixiru.com if its path matches the original embed and its host differs. Never replace a host or identifier. Parse explicit HLS or bounded standard packed data without executing destination scripts. Inspect playlists only; no segments. Signed URLs stay in memory and are not published.'
    if private['destination']:
        report['destination_validation']=await asyncio.to_thread(validate_destination,private['destination'],private['embed'],report.setdefault('events',[]))
        if report['destination_validation']['status']=='hls_playlists_accessible_playback_unverified':report['status']='hls_playlists_accessible_playback_unverified'
    else:report['destination_validation']={'status':'not_attempted','code':'approved_destination_not_observed','approved_hosts':sorted(TARGETS)}
    private.clear();return report

def self_test():
    passed=0
    def check(actual,expected):
        nonlocal passed
        assert actual==expected;passed+=1
    page=object();embed='https://streamwish.to/e/movie-id?token=original';target='https://hglamioz.com/e/movie-id?token=private';state={'embed':None,'destination':None}
    remember(embed,True,page,state);remember(target,True,page,state);check(state['destination'],target)
    for candidate in ('https://other-host.net/e/movie-id','https://hglamioz.com/e/other-id'):
        s={'embed':embed,'page':page,'destination':None};remember(candidate,True,page,s);check(s['destination'],None)
    s={'embed':embed,'page':page,'destination':None};remember(target,True,object(),s);check(s['destination'],None)
    packed=r"""eval(function(p,a,c,k,e,d){while(c--)p=p.replace('x','y');return p;}('0({1:"2://3/4.5"})',62,6,'jwplayer|file|https|cdn.fixturemedia.net|master|m3u8'.split('|'),0,{}))"""
    unpacked=unpack_one(packed);check('https://cdn.fixturemedia.net/master.m3u8' in unpacked,True)
    hls,stats=source_url('<script>'+packed+'</script>');check(stats['packed_layers_decoded_as_data'],1)
    check(hls,'https://cdn.fixturemedia.net/master.m3u8')
    check(unpack_one('fetch("https://private.net")'),None)
    playlist='#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nhigh.m3u8'
    calls=[]
    def fetch(url,hosts,referer,stage,events):
        calls.append(url);events.append({'stage':stage,'http_status':200})
        if url==target:return '<script>file:"https://cdn.fixturemedia.net/master.m3u8?token=private"</script>'
        if 'master.m3u8' in url:return playlist
        if url=='https://cdn.fixturemedia.net/high.m3u8':return '#EXTM3U\n#EXTINF:10,\nsegment.ts'
        raise RuntimeError('unexpected URL https://secret.net/?key=private')
    report=validate_destination(target,embed,[],fetch);check(report['status'],'hls_playlists_accessible_playback_unverified')
    check(report['playlist']['declared_max_height'],1080)
    assert not any(url.endswith('segment.ts') for url in calls);passed+=1
    text=json.dumps(report);assert 'token=' not in text and 'movie-id' not in text and 'https://' not in text;passed+=1
    try:safe_https('https://hglamioz.com/'+('x'*16000))
    except ProbeError:passed+=1
    else:raise AssertionError('long URL accepted')
    bomb="eval(function(p,a,c,k,e,d){while(c--)p=p.replace('x','y');return p;}('0 0 0',62,1,'"+('x'*800000)+"'.split('|'),0,{}))"
    try:unpack_one(bomb)
    except ProbeError:passed+=1
    else:raise AssertionError('unbounded packed expansion accepted')
    target='https://medixiru.com/e/movie-id?token=changed'
    s={'embed':embed,'page':page,'destination':None};remember(target,True,page,s);check(s['destination'],target)
    report=validate_destination(s['destination'],embed,[],fetch)
    check(report['status'],'hls_playlists_accessible_playback_unverified');check(report['host'],'medixiru.com')
    check(calls[-3],target)
    for candidate in ('https://medixiru.com/e/other-id','https://medixiru.com.evil.net/e/movie-id'):
        s={'embed':embed,'page':page,'destination':None};remember(candidate,True,page,s);check(s['destination'],None)
    calls.clear();report=validate_destination('https://other-host.net/e/movie-id',embed,[],fetch);check(calls,[])
    check(report['code'],'url_not_allowed')
    return{'passed':passed,'total':22,'scope':'Synthetic tests for both approved hosts, unchanged observed URLs, rejection of other hosts and paths, packed-data bounds and playlists. No actual destination access or playback verified.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(self_test()))
    else:
        path=Path('analysis/browser-routing-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(asyncio.run(run()),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
