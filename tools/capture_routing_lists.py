"""Capture routing lists and inspect only an approved same-run destination without executing its scripts."""
import asyncio
import hashlib
import json
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

async def run():
    import analyze_mainjs as base
    from playwright.async_api import BrowserContext
    import follow_hglamioz as previous
    from destination_inspection import APPROVED,authorized,inspect
    recorder=Recorder();metadata={'status':'main_script_not_seen'};private={};diagnostic={'status':'destination_not_fetched'}
    original_fetch=base.fetch_text;original_page=BrowserContext.new_page;original_targets=previous.TARGETS
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
    base.fetch_text=fetch;BrowserContext.new_page=new_page;previous.TARGETS=APPROVED
    try:report=await previous.run()
    finally:base.fetch_text=original_fetch;BrowserContext.new_page=original_page;previous.TARGETS=original_targets
    report['routing_assignment_capture']=recorder.summary()
    report['routing_assignment_capture']['instrumentation']=metadata
    report['routing_assignment_capture']['destination_memberships']={item['host']:[key for key,values in report['routing_assignment_capture']['lists'].items() if item['host'] in values] for item in report.get('navigation_candidates',[]) if isinstance(item,dict) and isinstance(item.get('host'),str)}
    report['routing_capture_scope']='AST-based value observation at named main/dmca/rules initializers and assignments, including local scopes. Original values returned unchanged. No source publication.'
    report['destination_structure']=diagnostic
    report['additional_scope']='After Chromium closes, contact only its exact observed same-path HTTPS destination if it is both on the five-host explicit diagnostic allowlist and in the unambiguous dmca list captured in this run. Inspect the returned HTML as data only. Existing HLS playlist checks remain; no destination scripts, linked resources, segments or video are requested by the added diagnostic. No host substitution.'
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
