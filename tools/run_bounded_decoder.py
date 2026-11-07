"""Evaluate selected routing AST in a data-only interpreter and compare passive observations."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
import analyze_mainjs as base

HERE=Path(__file__).parent
TARGET=Path('analysis/bounded-decoder-report.json')

def invoke(filename,source='',timeout=60):
    child=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(HERE/filename)],input=source,text=True,capture_output=True,timeout=timeout)
    if len(child.stdout)>200000:
        raise RuntimeError('bounded_output_limit')
    data=json.loads(child.stdout)
    if not isinstance(data,dict):
        raise RuntimeError('bounded_helper_failed')
    return child.returncode,data

def run():
    report={'status':'not_completed','scope':'Selected source AST operations are modeled under explicit data/step/time limits. No eval or Function, no browser, no destination requests or playback. This differs from structural inspection alone.'}
    private={}
    try:
        code,tests=invoke('test_bounded_route_decoder.cjs',timeout=30)
        if code or tests.get('passed')!=tests.get('total') or tests.get('passed')!=47:
            raise RuntimeError('bounded_self_test_failed')
        report['self_test']={'passed':47,'total':47}
        def capture(url,hosts,referer,stage,events):
            text=base.fetch_text(url,hosts,referer,stage,events)
            if stage=='main_script':private['source']=text
            return text
        inspected=base.analyze(capture)
        if inspected.get('status')!='static_inspection_complete' or 'source' not in private:
            report['status']='source_unavailable'
            return report
        source=private['source']
        report['main_script_sha256']=hashlib.sha256(source.encode('utf-8')).hexdigest()
        code,data=invoke('bounded_route_decoder.cjs',source)
        if code or data.get('status')!='ast_route_candidates_recovered':
            detail=data.get('code','')
            report['status']='unsupported'
            report['code']=detail if isinstance(detail,str) and re.fullmatch(r'ast_[a-z_]+',detail) else 'bounded_interpretation_failed'
            return report
        lists=data.get('lists',{})
        if set(lists)!={'main','dmca','rules'} or any(not isinstance(v,list) or not 1<=len(v)<=100 or any(not isinstance(x,str) or not re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z]{2,24}',x) for x in v) for v in lists.values()):
            raise RuntimeError('bounded_result_invalid')
        report['decoded_candidates']=lists
        report['interpreter_counters']=data.get('limits',{})
        reference=Path('analysis/browser-routing-report.json')
        if not reference.exists():
            report['status']='decoded_candidates_without_reference'
            return report
        observed=json.loads(reference.read_text())
        if observed.get('main_script_sha256')!=report['main_script_sha256']:
            report['status']='decoded_candidates_reference_hash_mismatch'
            return report
        expected=observed.get('routing_assignment_capture',{}).get('lists',{})
        report['matches_observed_lists']={name:lists[name]==expected.get(name) for name in ('main','dmca','rules')}
        report['status']='decoded_routes_match_observation' if all(report['matches_observed_lists'].values()) else 'decoded_routes_differ_from_observation'
    except subprocess.TimeoutExpired:
        report['status']='unsupported';report['code']='bounded_process_timeout'
    except Exception:
        report['status']='inspection_failed';report['code']='bounded_fetch_test_or_parse_failed'
    finally:
        private.clear()
    return report

if __name__=='__main__':
    TARGET.parent.mkdir(exist_ok=True)
    TARGET.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    TARGET.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
