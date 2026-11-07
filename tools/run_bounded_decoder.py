"""Run the bounded decoder with enum-only rejection instrumentation; never relax policy."""
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
import analyze_mainjs as base

HERE=Path(__file__).parent
TARGET=Path('analysis/bounded-decoder-report.json')
PROPERTY_CLASSES={'constructor','__proto__','prototype','caller','callee','eval','Function','process','require','fetch','document','window','oversized_key'}
RECEIVERS={'function','object','array','string','number','boolean','undefined','null','native_function','other'}
OPERATIONS={'read','write','other'}
PHASES={'rotation','route_main','route_dmca','route_rules','unclassified'}
NEW_PROPERTY="function property(k,receiver,operation='other'){k=string(k);if(k.length>1024||banned.has(k)){const receiver_kind=receiver instanceof Fn?'function':receiver instanceof Native?'native_function':receiver instanceof Obj?'object':Array.isArray(receiver)?'array':receiver===null?'null':['string','number','boolean','undefined'].includes(typeof receiver)?typeof receiver:'other';fatal('ast_property_forbidden',{property_class:k.length>1024?'oversized_key':k,receiver_kind,operation});}return k;}"
PROBES=r"""
'use strict';
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');
let passed=0;
for(const [source,expression,kind] of [['','({}).constructor','object'],['function f(){}','f.constructor','function'],['',"'private-string'.constructor",'string'],['','String.constructor','native_function']]){
 const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,500);m.hoist(ast.body,m.global,true);let rejected;
 try{m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}catch(e){rejected=e;}
 assert(rejected instanceof model.Fatal);assert.equal(rejected.code,'ast_property_forbidden');assert.deepEqual(rejected.blocked_access,{property_class:'constructor',receiver_kind:kind,operation:'read'});passed++;
}
const fixture='function table(){var a=["one.fixture.net"];return a;}function _0x5447(i,k){return table()[i];}(function(t){return t.constructor;})(table);const main=["one.fixture.net"],dmca=["two.fixture.net"],rules=["three.fixture.net"];';
let blocked;try{model.recover(fixture,{pin:null,limit:2000});}catch(e){blocked=e;}
assert(blocked instanceof model.Fatal);assert.equal(blocked.code,'ast_property_forbidden');assert.equal(blocked.phase,'rotation');assert.equal(blocked.blocked_access.receiver_kind,'function');passed++;
process.stdout.write(JSON.stringify({passed,total:5}));
"""

def invoke(filename,source='',timeout=60):
    path=Path(filename)
    if not path.is_absolute():path=HERE/path
    child=subprocess.run(['node','--expose-internals','--max-old-space-size=128',str(path)],input=source,text=True,capture_output=True,timeout=timeout)
    if len(child.stdout)>200000:raise RuntimeError('bounded_output_limit')
    data=json.loads(child.stdout)
    if not isinstance(data,dict):raise RuntimeError('bounded_helper_failed')
    return child.returncode,data

def replace_once(text,old,new):
    if text.count(old)!=1:raise RuntimeError('bounded_instrumentation_shape_changed')
    return text.replace(old,new)

def instrument(source):
    source=replace_once(source,"function fatal(code){throw new Fatal(code);}","function fatal(code,detail){const error=new Fatal(code);if(detail)error.blocked_access=detail;throw error;}")
    source=replace_once(source,"function property(k){k=string(k);if(k.length>1024||banned.has(k))fatal('ast_property_forbidden');return k;}",NEW_PROPERTY)
    source=replace_once(source,"function read(obj,k){tick();k=property(k);","function read(obj,k){tick();k=property(k,obj,'read');")
    source=replace_once(source,"function write(obj,k,value){tick();k=property(k);guard(value);","function write(obj,k,value){tick();k=property(k,obj,'write');guard(value);")
    source=replace_once(source,"if(e instanceof Fatal)throw e;fatal('ast_rotation_evaluation_failed');","if(e instanceof Fatal){e.phase='rotation';throw e;}fatal('ast_rotation_evaluation_failed');")
    source=replace_once(source,"if(e instanceof Fatal)throw e;fatal('ast_route_evaluation_failed');","if(e instanceof Fatal){e.phase='route_'+name;throw e;}fatal('ast_route_evaluation_failed');")
    source=replace_once(source,"code:e instanceof Fatal&&/^ast_[a-z_]+$/.test(e.code)?e.code:'ast_interpretation_failed'","code:e instanceof Fatal&&/^ast_[a-z_]+$/.test(e.code)?e.code:'ast_interpretation_failed',blocked_access:e instanceof Fatal?e.blocked_access:undefined,phase:e instanceof Fatal&&e.phase?e.phase:'unclassified'")
    return source

def check_tests(path,total):
    code,data=invoke(path,timeout=30)
    if code or data.get('passed')!=total or data.get('total')!=total:raise RuntimeError('bounded_self_test_failed')
    return {'passed':total,'total':total}

def clean_access(data):
    detail=data.get('blocked_access')
    if not isinstance(detail,dict):return None
    if detail.get('property_class') not in PROPERTY_CLASSES or detail.get('receiver_kind') not in RECEIVERS or detail.get('operation') not in OPERATIONS:return None
    return {**{key:detail[key] for key in ('property_class','receiver_kind','operation')},'phase':data.get('phase') if data.get('phase') in PHASES else 'unclassified'}

def run():
    report={'status':'not_completed','scope':'Selected source AST operations are modeled under unchanged data/step/time limits. Rejected-access diagnostics contain fixed enums only. No eval or Function, no browser, no destination requests or playback.'}
    private={}
    try:
        report['base_self_test']=check_tests('test_bounded_route_decoder.cjs',47)
        original=(HERE/'bounded_route_decoder.cjs').read_text(encoding='utf-8')
        patched=instrument(original)
        with tempfile.TemporaryDirectory(prefix='kofum-bounded-rejection-') as directory:
            directory=Path(directory)
            helper=directory/'bounded_route_decoder.cjs';helper.write_text(patched,encoding='utf-8');helper.chmod(0o600)
            tests=directory/'test_bounded_route_decoder.cjs';tests.write_bytes((HERE/'test_bounded_route_decoder.cjs').read_bytes());tests.chmod(0o600)
            probes=directory/'probe_rejected_access.cjs';probes.write_text(PROBES,encoding='utf-8');probes.chmod(0o600)
            report['instrumented_regression_test']=check_tests(tests,47)
            report['rejection_diagnostic_test']=check_tests(probes,5)
            report['self_test']={'passed':52,'total':52,'base_cases':47,'diagnostic_cases':5}
            report['interpreter_provenance']={'repository_sha256':hashlib.sha256(original.encode('utf-8')).hexdigest(),'effective_sha256':hashlib.sha256(patched.encode('utf-8')).hexdigest(),'instrumentation':'rejected_property_enums_only'}
            def capture(url,hosts,referer,stage,events):
                text=base.fetch_text(url,hosts,referer,stage,events)
                if stage=='main_script':private['source']=text
                return text
            inspected=base.analyze(capture)
            if inspected.get('status')!='static_inspection_complete' or 'source' not in private:
                report['status']='source_unavailable';return report
            source=private['source']
            report['main_script_sha256']=hashlib.sha256(source.encode('utf-8')).hexdigest()
            code,data=invoke(helper,source)
            if code or data.get('status')!='ast_route_candidates_recovered':
                detail=data.get('code','');report['status']='unsupported'
                report['code']=detail if isinstance(detail,str) and re.fullmatch(r'ast_[a-z_]+',detail) else 'bounded_interpretation_failed'
                access=clean_access(data)
                if access:report['blocked_access']=access
                return report
            lists=data.get('lists',{})
            if set(lists)!={'main','dmca','rules'} or any(not isinstance(v,list) or not 1<=len(v)<=100 or any(not isinstance(x,str) or not re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z]{2,24}',x) for x in v) for v in lists.values()):raise RuntimeError('bounded_result_invalid')
            report['decoded_candidates']=lists;report['interpreter_counters']=data.get('limits',{})
            reference=Path('analysis/browser-routing-report.json')
            if not reference.exists():report['status']='decoded_candidates_without_reference';return report
            observed=json.loads(reference.read_text())
            if observed.get('main_script_sha256')!=report['main_script_sha256']:report['status']='decoded_candidates_reference_hash_mismatch';return report
            expected=observed.get('routing_assignment_capture',{}).get('lists',{})
            report['matches_observed_lists']={name:lists[name]==expected.get(name) for name in ('main','dmca','rules')}
            report['status']='decoded_routes_match_observation' if all(report['matches_observed_lists'].values()) else 'decoded_routes_differ_from_observation'
    except subprocess.TimeoutExpired:
        report['status']='unsupported';report['code']='bounded_process_timeout'
    except Exception as error:
        allowed={'bounded_output_limit','bounded_helper_failed','bounded_instrumentation_shape_changed','bounded_self_test_failed','bounded_result_invalid'}
        report['status']='inspection_failed';report['code']=str(error) if isinstance(error,RuntimeError) and str(error) in allowed else 'bounded_fetch_test_or_parse_failed'
    finally:
        private.clear()
    return report

if __name__=='__main__':
    TARGET.parent.mkdir(exist_ok=True)
    TARGET.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    TARGET.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
