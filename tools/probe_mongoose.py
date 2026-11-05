"""Fresh-title probe. No Nemo fallback, no plugin changes, sanitized reports only."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

URL='https://gnula.life/movies/the-mongoose'
SLUG='the-mongoose'
class ProbeError(Exception):pass

def movie_data(html):
    if not isinstance(html,str) or len(html)>3000000:raise ProbeError('invalid_html')
    matches=[body for attrs,body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html,re.I) if re.search(r'\bid\s*=\s*["\']__NEXT_DATA__["\']',attrs)]
    if len(matches)!=1:raise ProbeError('missing_next_data')
    post=json.loads(matches[0])['props']['pageProps']['post']
    if post.get('slug',{}).get('name')!=SLUG:raise ProbeError('movie_slug_mismatch')
    return post

def player(post,server):
    rows=[p for p in post.get('players',{}).get('latino',[]) if p.get('cyberlocker')==server]
    if len(rows)!=1:raise ProbeError('server_not_unique')
    url=rows[0].get('result','')
    if not re.fullmatch(r'https://player\.gnula\.life/player\.php\?h=[A-Za-z0-9_.~-]+',url):raise ProbeError('invalid_intermediate')
    return url

def metadata(post):
    imdb=str(post.get('IMDbId',''));tmdb=str(post.get('TMDbId',''))
    return{'slug':SLUG,'imdb':imdb if re.fullmatch(r'tt\d{5,12}',imdb) else '', 'tmdb':tmdb if re.fullmatch(r'\d{1,10}',tmdb) else '',
           'latino_servers':[server for server in ('streamwish','streamtape') if any(p.get('cyberlocker')==server for p in post.get('players',{}).get('latino',[]))]}

def explicit_hls(html):
    urls=[]
    for _,body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html,re.I):
        for _,value in re.findall(r"""(?:\bfile|\bsrc|["']file["']|["']src["'])\s*:\s*(["'])([^"'\r\n]+)\1""",body):
            url=value.replace('\\/','/').replace('&amp;','&')
            if re.search(r'\.m3u8(?:[?#]|$)',url,re.I) and url not in urls:urls.append(url)
    if len(urls)>1:raise ProbeError('ambiguous_hls')
    return urls[0] if urls else None

def run():
    import analyze_mainjs as base
    import probe_streamtape as streamtape
    report={'requested_slug':SLUG,'scope':'Fresh movie page; no Nemo links reused. No playback or decoding verification.','streamwish':{'status':'not_completed'}}
    events=[];report['streamwish']['events']=events;stage='movie';page=None;post=None
    try:
        page=base.fetch_text(URL,{'gnula.life'},'https://gnula.life/',stage,events)
        post=movie_data(page);report['movie']=metadata(post)
        middle=player(post,'streamwish');stage='intermediate'
        html=base.fetch_text(middle,{'player.gnula.life'},URL,stage,events);embed=base.embed_url(html)
        stage='server';html=base.fetch_text(embed,base.EMBED_HOSTS,URL,stage,events)
        report['streamwish']['server_host']=urlsplit(embed).hostname
        report['streamwish']['server_characters']=len(html)
        hls=explicit_hls(html)
        if hls:
            host=urlsplit(hls).hostname
            base.checked_url(hls,{host});stage='hls'
            body=base.fetch_text(hls,{host},'https://'+urlsplit(embed).netloc+'/',stage,events)
            report['streamwish']['status']='hls_playlist_header_observed' if re.match(r'\s*#EXTM3U\b',body) else 'hls_candidate_not_a_playlist'
        else:
            stage='main_script';main=base.main_script(html,embed)
            js=base.fetch_text(main,{urlsplit(embed).hostname},embed,stage,events)
            inspected=base.inspect_script(js);report['streamwish']['script']=inspected
            report['streamwish']['status']='loader_retrieved_video_not_resolved'
            previous=Path('analysis/mainjs-decoded-report.json')
            if previous.exists():
                old=json.loads(previous.read_text(encoding='utf-8')).get('source_inspection',{}).get('script',{}).get('sha256_utf8')
                report['streamwish']['same_loader_hash_as_nemo_analysis']=bool(old and old==inspected['sha256_utf8'])
    except Exception as error:
        code=str(error) if isinstance(error,(ProbeError,base.AnalysisError)) else ''
        report['streamwish']['status']='unsupported_or_failed'
        report['streamwish']['failure']={'stage':stage,'code':code if re.fullmatch(r'[a-z_]+(?:_\d{3})?',code) else 'network_or_parse_error'}
    if post is not None and 'streamtape' in metadata(post)['latino_servers']:
        streamtape.MOVIE=URL
        streamtape.post_player=lambda html:player(movie_data(html),'streamtape')
        def cached_fetch(url,hosts,referer,stage,events):
            if url==URL:
                events.append({'stage':'movie_cached_from_fresh_page','http_status':200})
                return page
            return base.fetch_text(url,hosts,referer,stage,events)
        alternate=streamtape.probe(fetch=cached_fetch)
        alternate['source']='Gnula The Mongoose Latino Streamtape'
        report['streamtape']=alternate
    else:report['streamtape']={'status':'not_available_or_movie_page_unverified'}
    return report

def self_test():
    post={'slug':{'name':SLUG},'IMDbId':'tt1234567','TMDbId':'345678','players':{'latino':[{'cyberlocker':'streamwish','result':'https://player.gnula.life/player.php?h=newfixture'}], 'spanish':[{'cyberlocker':'streamtape','result':'https://player.gnula.life/player.php?h=notlatino'}]},'downloads':[{'cyberlocker':'streamwish','result':'https://other.net/download'}]}
    def page(p):return '<script id="__NEXT_DATA__">'+json.dumps({'props':{'pageProps':{'post':p}}})+'</script>'
    passed=0
    assert movie_data(page(post))['TMDbId']=='345678';passed+=1
    assert player(movie_data(page(post)),'streamwish').endswith('h=newfixture');passed+=1
    assert metadata(post)['latino_servers']==['streamwish'];passed+=1
    for p in ({**post,'slug':{'name':'buscando-a-nemo'}},{**post,'slug':{} }):
        try:movie_data(page(p))
        except ProbeError:passed+=1
        else:raise AssertionError('wrong movie accepted')
    try:player(post,'streamtape')
    except ProbeError:passed+=1
    else:raise AssertionError('non-latino accepted')
    assert explicit_hls('<script>file:"https://cdn.fixturemedia.net/test.m3u8?token=fixture"</script>').startswith('https://cdn.fixturemedia.net/');passed+=1
    assert explicit_hls('<script src="/main.js"></script>') is None;passed+=1
    try:explicit_hls('<script>file:"https://a.net/a.m3u8";src:"https://a.net/b.m3u8";</script>')
    except ProbeError:passed+=1
    else:raise AssertionError('ambiguous source accepted')
    assert metadata({**post,'IMDbId':'https://secret.net/?token=private'})['imdb']=='';passed+=1
    return{'passed':passed,'total':10,'scope':'Synthetic new-title parsing only; actual movie, server access and playback untested.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(self_test()))
    else:
        path=Path('analysis/the-mongoose-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
