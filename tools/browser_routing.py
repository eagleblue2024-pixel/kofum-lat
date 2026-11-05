"""Instrumented, network-restricted browser observation. No video or raw-source output."""
import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

VERSION='1.64.1'
CAPTURE=r"""
;(()=>{try{
 const values={main:typeof main==='undefined'?null:main,dmca:typeof dmca==='undefined'?null:dmca,rules:typeof rules==='undefined'?null:rules};
 const out={};
 for(const key of ['main','dmca','rules']){const value=values[key];if(Array.isArray(value)&&value.length<=100&&value.every(x=>typeof x==='string'&&x.length<=253))out[key]=value;}
 window.__kofumObservedRoutes=out;
}catch(_){}})();
"""

class ProbeError(Exception):pass

def public_name(host):
    return isinstance(host,str) and bool(re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}',host)) and not host.endswith(('.local','.localhost','.internal','.test','.invalid','.example'))

def decision(url,kind,method,embed,main_navigation,initial_served):
    try:
        p=urlsplit(url);origin=urlsplit(embed)
        if p.scheme!='https' or not public_name(p.hostname) or p.username or p.password or p.port not in(None,443) or method!='GET':return 'abort'
        if main_navigation and url!=embed:return 'navigation'
        if kind=='media' or re.search(r'\.(?:m3u8|mp4)(?:[?#]|$)',url,re.I):return 'media'
        if kind=='document' and main_navigation and url==embed and not initial_served:return 'document'
        if kind=='script' and p.hostname==origin.hostname:return 'script'
    except ValueError:pass
    return 'abort'

def observation(url,kind,embed):
    p=urlsplit(url);original=urlsplit(embed)
    return {'host':p.hostname if public_name(p.hostname) else 'redacted','kind':kind,
            'original_path_preserved':p.path==original.path,
            'media_suffix':'m3u8' if re.search(r'\.m3u8(?:[?#]|$)',url,re.I) else 'mp4' if re.search(r'\.mp4(?:[?#]|$)',url,re.I) else 'none'}

def routing_data(value):
    if not isinstance(value,dict):return {}
    output={}
    for key in ('main','dmca','rules'):
        values=value.get(key)
        if isinstance(values,list) and len(values)<=100 and all(public_name(x) for x in values):output[key]=values
    return output

async def observe(report):
    import analyze_mainjs as base
    import probe_mongoose as movie
    from playwright.async_api import async_playwright
    events=report['events'];report['phase']='source_fetch'
    html=await asyncio.to_thread(base.fetch_text,movie.URL,{'gnula.life'},'https://gnula.life/','movie',events)
    post=movie.movie_data(html);report['movie']=movie.metadata(post)
    middle=movie.player(post,'streamwish')
    html=await asyncio.to_thread(base.fetch_text,middle,{'player.gnula.life'},movie.URL,'intermediate',events)
    embed=base.embed_url(html);host=urlsplit(embed).hostname
    source=await asyncio.to_thread(base.fetch_text,embed,base.EMBED_HOSTS,movie.URL,'server',events)
    main=base.main_script(source,embed)
    main_has_integrity=False
    for entry in base.scripts_in(source):
        if entry['attrs'].get('integrity') and 'main.js' in entry['attrs'].get('src',''):main_has_integrity=True
    report['server_host']=host;report['server_characters']=len(source)
    report['instrumentation_skipped_for_integrity']=main_has_integrity
    state={'initial':False,'requests':0,'upstream':0,'script_errors':0,'popups_closed':0}
    navigations=[];media=[];blocked=[];signal=asyncio.Event()
    report['phase']='browser_launch'
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,chromium_sandbox=True,timeout=25000,
            args=['--disable-background-networking','--disable-component-update','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
        try:
            report['browser_version']=browser.version
            context=await browser.new_context(accept_downloads=False,service_workers='block',permissions=[],user_agent=base.UA)
            async def close_socket(ws):
                try:await ws.close()
                except Exception:pass
            await context.route_web_socket('**/*',close_socket)
            page=await context.new_page()
            async def quiet_close(popup):
                try:await popup.close()
                except Exception:pass
            async def quiet_dismiss(dialog):
                try:await dialog.dismiss()
                except Exception:pass
            def close_popup(popup):
                state['popups_closed']+=1
                asyncio.create_task(quiet_close(popup))
            context.on('page',close_popup)
            page.on('pageerror',lambda _error:state.__setitem__('script_errors',state['script_errors']+1))
            page.on('dialog',lambda dialog:asyncio.create_task(quiet_dismiss(dialog)))
            async def route_request(route):
                request=route.request;state['requests']+=1
                try:
                    is_main=request.is_navigation_request() and request.frame==page.main_frame
                    action=decision(request.url,request.resource_type,request.method,embed,is_main,state['initial'])
                    if state['requests']>30:await route.abort();return
                    if action=='navigation':
                        if len(navigations)<10:navigations.append(observation(request.url,'main_frame_navigation',embed))
                        signal.set();await route.abort();return
                    if action=='media':
                        if len(media)<10:media.append(observation(request.url,'media_candidate',embed))
                        signal.set();await route.abort();return
                    if action=='abort':
                        if len(blocked)<15:blocked.append(observation(request.url,request.resource_type,embed))
                        await route.abort();return
                    if action=='document':
                        state['initial']=True
                        await route.fulfill(status=200,content_type='text/html; charset=utf-8',body=source)
                        return
                    if state['upstream']>=8:await route.abort();return
                    state['upstream']+=1
                    body=await asyncio.to_thread(base.fetch_text,request.url,{host},embed,'browser_script',events)
                    if request.url==main:
                        report['main_script_sha256']=hashlib.sha256(body.encode('utf-8')).hexdigest()
                        report['main_script_characters']=len(body)
                        if not main_has_integrity:body+=CAPTURE
                    await route.fulfill(status=200,content_type='application/javascript; charset=utf-8',body=body)
                except Exception:
                    try:await route.abort()
                    except Exception:pass
            await context.route('**/*',route_request)
            report['phase']='browser_observation'
            try:await page.goto(embed,wait_until='domcontentloaded',timeout=20000)
            except Exception:report['initial_navigation_not_completed']=True
            try:await asyncio.wait_for(signal.wait(),timeout=12)
            except asyncio.TimeoutError:pass
            try:
                values=await asyncio.wait_for(page.evaluate('() => window.__kofumObservedRoutes || null'),timeout=3)
                report['observed_routing_lists']=routing_data(values)
            except Exception:report['observed_routing_lists']={}
            report['navigation_candidates']=navigations;report['media_candidates']=media
            report['blocked_resources']=blocked;report['browser_counters']=state
            lists=report['observed_routing_lists']
            if all(key in lists for key in ('main','dmca','rules')):
                report['status']='routing_lists_observed'
                selected='main' if host in lists['rules'] else 'dmca'
                report['routing_preview']={'selected_list':selected,'candidate_domains':lists[selected]}
            elif navigations:report['status']='navigation_candidate_observed'
            elif media:report['status']='media_candidate_observed'
            else:report['status']='no_routing_observed_in_restricted_context'
            report['phase']='completed'
        finally:await browser.close()

async def run():
    report={'requested_slug':'the-mongoose','status':'not_completed','phase':'starting','playwright_version':VERSION,'events':[],
            'scope':'Instrumented isolated Chromium, temporary context, no personal cookies. Only the initial document and same-origin scripts are served through pinned HTTPS. New navigations and media are intercepted and aborted. Minimal response headers may differ from a normal browser. No video, raw source, complete URLs, paths, query parameters or trace files are published. This is not a playback test.'}
    try:await asyncio.wait_for(observe(report),timeout=80)
    except Exception as error:
        report['status']='browser_probe_failed'
        report['error_class']=type(error).__name__ if re.fullmatch(r'[A-Za-z_]{1,60}',type(error).__name__) else 'redacted_error'
    return report

def self_test():
    passed=0
    def check(actual,expected):
        nonlocal passed
        assert actual==expected;passed+=1
    embed='https://streamwish.to/e/movie-id?token=private'
    check(decision(embed,'document','GET',embed,True,False),'document')
    check(decision(embed,'document','GET',embed,True,True),'abort')
    check(decision('https://streamwish.to/main.js','script','GET',embed,False,True),'script')
    check(decision('https://other-host.net/main.js','script','GET',embed,False,True),'abort')
    check(decision('https://next-host.net/e/movie-id?secret=key','document','GET',embed,True,True),'navigation')
    check(decision('https://cdn.mediahost.net/master.m3u8?secret=key','fetch','GET',embed,False,True),'media')
    check(decision('file:///etc/passwd','document','GET',embed,True,True),'abort')
    check(decision('https://streamwish.to/main.js','script','POST',embed,False,True),'abort')
    check(decision('https://127.0.0.1/main.js','script','GET',embed,False,True),'abort')
    text=json.dumps(observation('https://next-host.net/e/movie-id?secret=key','navigation',embed))
    assert 'movie-id' not in text and 'secret=' not in text and 'https://' not in text;passed+=1
    check(routing_data({'main':['medixiru.com'],'dmca':['https://secret.net/path?token=key'],'rules':['streamwish.to']}),{'main':['medixiru.com'],'rules':['streamwish.to']})
    check(routing_data(None),{})
    return{'passed':passed,'total':12,'scope':'Offline policy and report-redaction checks only. Chromium launch and actual script execution not tested locally.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(self_test()))
    else:
        path=Path('analysis/browser-routing-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(asyncio.run(run()),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
