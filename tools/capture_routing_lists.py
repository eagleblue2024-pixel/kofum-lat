"""Capture routing lists, inspect destination data and verify only a unique static JW HLS playlist."""
import asyncio
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

class Recorder:
    def __init__(self):self.values={};self.ambiguous=set();self.notes={};self.calls=0
    def record(self,name,values,kind):
        from browser_routing import routing_data
        self.calls+=1
        if self.calls>30 or not isinstance(name,str) or name not in ('main','dmca','rules'):return
        if kind not in ('domains','not_domain_list','not_array'):return
        self.notes[name]=kind
        if kind!='domains':
            if name in self.values:self.ambiguous.add(name)
            return
        clean=routing_data({name:values})
        if name not in clean:
            self.notes[name]='rejected_data'
            if name in self.values:self.ambiguous.add(name)
            return
        if name in self.values and self.values[name]!=clean[name]:self.ambiguous.add(name)
        self.values[name]=clean[name]
    def summary(self):
        lists={key:value for key,value in self.values.items() if key not in self.ambiguous}
        return {'status':'complete' if len(lists)==3 else 'partial_or_missing','lists':lists,'ambiguous_keys':sorted(self.ambiguous),'value_kinds':self.notes,'binding_calls':self.calls,
                'note':'Observed source data; destination contact additionally requires the explicit diagnostic allowlist and same-run membership. Not evidence of playback.'}

def transform(body):
    parser=Path(__file__).with_name('instrument_routing.cjs')
    result=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(parser)],input=body,text=True,capture_output=True,timeout=8)
    if result.returncode:raise RuntimeError('ast_parser_failed')
    data=json.loads(result.stdout)
    if data.get('status')!='instrumented' or not isinstance(data.get('source'),str):raise RuntimeError('ast_parser_failed')
    return data

def source_from_packed(html,fallback):
    import analyze_mainjs as base
    import follow_hglamioz as previous
    scripts=base.scripts_in(html)
    if len(scripts)>40:raise previous.ProbeError('jw_script_limit')
    bodies=[''.join(s['chunks']) for s in scripts if not s['attrs'].get('src')]
    bodies=[body for body in bodies if re.search(r'\beval\s*\(\s*function\b',body)]
    if not bodies:return fallback(html)
    if len(bodies)>4:raise previous.ProbeError('jw_packed_script_limit')
    urls=set();extractor=Path(__file__).with_name('extract_jw_hls.cjs')
    for body in bodies:
        if len(body)>200000:raise previous.ProbeError('jw_packed_input_limit')
        try:
            result=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(extractor)],input=body,text=True,capture_output=True,timeout=8)
            if len(result.stdout)>100000:raise previous.ProbeError('jw_result_limit')
            data=json.loads(result.stdout)
        except previous.ProbeError:raise
        except Exception:raise previous.ProbeError('jw_parse_or_decode_failed') from None
        if result.returncode or data.get('status')!='jw_hls_unique':
            code=data.get('code','')
            raise previous.ProbeError(code if isinstance(code,str) and re.fullmatch(r'jw_[a-z_]+',code) else 'jw_parse_or_decode_failed')
        url=data.get('url')
        if not isinstance(url,str):raise previous.ProbeError('jw_source_url_rejected')
        previous.safe_https(url);urls.add(url)
    if len(urls)!=1:raise previous.ProbeError('jw_hls_ambiguous')
    return urls.pop(),{'method':'static_jw_setup_from_packed_ast','packed_blocks':len(bodies),'note':'Bounded statically resolved strings in JW configuration from a dictionary-decoding candidate. Playlist access is not proof of playback or movie identity. Signed source stays in memory.'}

async def run():
    import analyze_mainjs as base
    from playwright.async_api import BrowserContext
    import follow_hglamioz as previous
    from destination_inspection import APPROVED,authorized,inspect
    test=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(Path(__file__).with_name('extract_jw_hls.cjs')),'--self-test'],capture_output=True,text=True,timeout=8)
    if test.returncode:raise RuntimeError('jw_extractor_self_test_failed')
    test_data=json.loads(test.stdout)
    if not isinstance(test_data.get('passed'),int) or test_data['passed']!=test_data.get('total') or not 1<=test_data['passed']<=1000:raise RuntimeError('jw_extractor_self_test_failed')
    recorder=Recorder();metadata={'status':'main_script_not_seen'};private={};diagnostic={'status':'destination_not_fetched'}
    original_fetch=base.fetch_text;original_page=BrowserContext.new_page;original_targets=previous.TARGETS;original_source=previous.source_url
    def fetch(url,hosts,referer,stage,events):
        if stage=='destination':
            destination=base.checked_url(url,APPROVED)
            if not authorized(destination.hostname,recorder.summary()):raise base.AnalysisError('destination_not_in_observed_lists')
        body=original_fetch(url,hosts,referer,stage,events)
        if stage=='destination':diagnostic.update(inspect(body,url))
        if stage=='server':
            private['main']=base.main_script(body,url)
            private['integrity']=any(entry['attrs'].get('integrity') and 'main.js' in entry['attrs'].get('src','') for entry in base.scripts_in(body))
        if stage=='browser_script' and url==private.get('main'):
            metadata['original_sha256']=hashlib.sha256(body.encode('utf-8')).hexdigest();metadata['original_characters']=len(body)
            if private.get('integrity'):metadata['status']='integrity_preserved_not_instrumented';return body
            try:
                data=transform(body)
                for key in ('status','counts','parser_version','node_version'):metadata[key]=data[key]
                return data['source']
            except Exception:metadata['status']='ast_parser_failed';return body
        return body
    async def new_page(context,*args,**kwargs):
        page=await original_page(context,*args,**kwargs)
        await page.expose_function('__kofumReportRouteList',recorder.record)
        return page
    base.fetch_text=fetch;BrowserContext.new_page=new_page;previous.TARGETS=APPROVED;previous.source_url=lambda html:source_from_packed(html,original_source)
    try:report=await previous.run()
    finally:base.fetch_text=original_fetch;BrowserContext.new_page=original_page;previous.TARGETS=original_targets;previous.source_url=original_source
    report['routing_assignment_capture']=recorder.summary()
    report['routing_assignment_capture']['instrumentation']=metadata
    report['routing_assignment_capture']['destination_memberships']={item['host']:[key for key,values in report['routing_assignment_capture']['lists'].items() if item['host'] in values] for item in report.get('navigation_candidates',[]) if isinstance(item,dict) and isinstance(item.get('host'),str)}
    report['routing_capture_scope']='AST-based value observation at named main/dmca/rules initializers and assignments, including local scopes. Original values returned unchanged. No source publication.'
    report['destination_structure']=diagnostic
    report['jw_extractor_self_test']={'status':'passed','passed':test_data['passed'],'total':test_data['total']}
    report['additional_scope']='Contact only the exact observed same-path HTTPS destination on the explicit five-host allowlist and same-run dmca list. Parse its HTML and packed data without executing destination scripts. Resolve only bounded literal strings, concatenations and uniquely initialized visible identifiers before use. Select one unambiguous static JW HLS source and pass it to existing pinned-HTTPS playlist verification. Playlist hosts come from that configuration and playlist variants; public DNS and TLS checks remain. No redirects, linked destination scripts, keys, segments or video requested. Signed URLs stay private.'
    report['diagnostic_approved_hosts']=sorted(APPROVED)
    if 'original_sha256' in metadata:
        if metadata['status']=='instrumented' and 'main_script_sha256' in report:report['instrumented_main_before_tail_sha256']=report['main_script_sha256']
        report['main_script_sha256']=metadata['original_sha256'];report['main_script_characters']=metadata['original_characters']
    private.clear();return report

def self_test():
    recorder=Recorder();recorder.record('main',['medixiru.com'],'domains');recorder.record('dmca',['hglamioz.com'],'domains');recorder.record('rules',['streamwish.to'],'domains')
    assert recorder.summary()['status']=='complete'
    recorder.record('main',['playnixes.com'],'domains');assert recorder.summary()['ambiguous_keys']==['main']
    assert 'main' not in recorder.summary()['lists']
    recorder.record('rules',['https://private.net/?token=secret'],'domains');assert 'rules' not in recorder.summary()['lists']
    assert 'secret' not in json.dumps(recorder.summary())
    from destination_inspection import self_test as inspect_test
    extra=inspect_test()
    return {'passed':5+extra['passed'],'total':5+extra['total'],'scope':'Synthetic recorder, static structure, same-run membership and redaction tests; no browser or remote source executed.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(self_test()))
    else:
        path=Path('analysis/browser-routing-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(asyncio.run(run()),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
