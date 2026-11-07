"""Inspect routing data statically; never execute source functions or contact destinations."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
import analyze_mainjs as base

TARGET = Path('analysis/static-routing-report.json')
HELPER = Path(__file__).with_name('static_routes.cjs')

def node_report(source='', self_test=False):
    command = ['node','--expose-internals','--max-old-space-size=128',str(HELPER)]
    if self_test:
        command.append('--self-test')
    child = subprocess.run(command,input=source,text=True,capture_output=True,timeout=12)
    if child.returncode or len(child.stdout)>200000:
        raise RuntimeError('static_helper_failed')
    data = json.loads(child.stdout)
    if not isinstance(data,dict):
        raise RuntimeError('static_helper_failed')
    return data

def run():
    report = {'status':'not_completed','scope':'AST-only route candidates and decoder structure. No source execution, destination requests, identifier migration or playback.'}
    private = {}
    try:
        tests = node_report(self_test=True)
        if not isinstance(tests.get('passed'),int) or tests['passed']!=tests.get('total') or not 1<=tests['passed']<=1000:
            raise RuntimeError('static_self_test_failed')
        report['self_test'] = {'passed':tests['passed'],'total':tests['total']}
        def capture(url,hosts,referer,stage,events):
            text = base.fetch_text(url,hosts,referer,stage,events)
            if stage=='main_script':
                private['source']=text
            return text
        inspection = base.analyze(capture)
        if inspection.get('status')!='static_inspection_complete' or 'source' not in private:
            report['status']='source_unavailable'
            return report
        source=private['source']
        report['main_script_sha256']=hashlib.sha256(source.encode('utf-8')).hexdigest()
        report['main_script_characters']=len(source)
        report['analysis']=node_report(source)
        report['status']=report['analysis'].get('status','analysis_failed')
    except Exception:
        report['status']='inspection_failed'
        report['code']='static_fetch_parse_or_limit_failed'
    finally:
        private.clear()
    return report

if __name__=='__main__':
    TARGET.parent.mkdir(exist_ok=True)
    TARGET.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    TARGET.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
