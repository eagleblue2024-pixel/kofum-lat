"""Model isolated function prototype data and bounded primitive conversions without hooks."""
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
NEW_READ_PREFIX="function read(obj,k){tick();if(k==='prototype'&&obj instanceof Fn&&obj.node&&['FunctionDeclaration','FunctionExpression'].includes(obj.node.type)&&!obj.node.async&&!obj.node.generator){if(!obj.p.has('prototype')){if(++allocations>10000)fatal('ast_allocation_limit');obj.p.set('prototype',new Obj());}return obj.p.get('prototype');}k=property(k,obj,'read');"
NEW_PRIMITIVE="function primitive(v,seen=new Set(),level=0){tick();if(['function','symbol','bigint'].includes(typeof v))fatal('ast_host_value_unsupported');if(v===null||typeof v!=='object')return v;if(level>8)fatal('ast_coercion_depth_limit');if(v instanceof Native)fatal('ast_native_coercion_unsupported');const fields=v instanceof Obj?v.p:Array.isArray(v)?own(v):null;if(!fields)fatal('ast_object_coercion_unsupported');if(fields.has('toString')||fields.has('valueOf')||Array.isArray(v)&&fields.has('join'))fatal('ast_custom_coercion_unsupported');if(v instanceof Fn){if(!v.node||!Number.isInteger(v.node.start)||!Number.isInteger(v.node.end))fatal('ast_function_text_unavailable');return guard(source.slice(v.node.start,v.node.end));}if(v instanceof Obj)return '[object Object]';if(seen.has(v))fatal('ast_cyclic_coercion_unsupported');seen.add(v);try{let out='';for(let i=0;i<v.length;i++){tick();const item=v[i],part=item==null?'':String(primitive(item,seen,level+1));out=guard(out+(i?',':'')+part);}return out;}finally{seen.delete(v);}}"
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
PROTOTYPE_PROBES=r"""
'use strict';
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');let passed=0;
function evaluate(source,expression){const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,20000);m.hoist(ast.body,m.global,true);return m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}
for(const [source,expression,expected] of [
 ['function f(){}','f.prototype===f.prototype',true],
 ['function f(){}function g(){}','f.prototype===g.prototype',false],
 ['function f(){}function g(){}function run(){f.prototype.cache="local";return g.prototype.cache;}','run()',undefined],
 ['function f(){}function run(){f.prototype.count=7;return f.prototype.count;}','run()',7]
]){assert.deepEqual(evaluate(source,expression),expected);passed++;}
for(const expression of ['f.prototype.constructor','f.prototype.__proto__','f.prototype.prototype','String.prototype','Array.prototype','f.prototype={}']){let blocked;try{evaluate('function f(){}',expression);}catch(e){blocked=e;}assert(blocked instanceof model.Fatal);assert.equal(blocked.code,'ast_property_forbidden');passed++;}
const fixture='function table(){var a=["one.fixture.net"];return a;}function _0x5447(i,k){return table()[i];}(function(t){t.prototype.cache=1;})(table);const main=["one.fixture.net"],dmca=["two.fixture.net"],rules=["three.fixture.net"];';
const report=model.recover(fixture,{pin:null,limit:20000});assert.deepEqual(report.lists,{main:['one.fixture.net'],dmca:['two.fixture.net'],rules:['three.fixture.net']});passed++;
process.stdout.write(JSON.stringify({passed,total:11}));
"""
COERCION_PROBES=r"""
'use strict';
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');let passed=0;
function evaluate(source,expression){const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,30000);m.hoist(ast.body,m.global,true);return m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}
for(const [source,expression,expected] of [
 ['','String({})','[object Object]'],['','"id:"+{}','id:[object Object]'],['','Number({})',NaN],['','[]+""',''],['','String([1,null,undefined,2])','1,,,2'],['','String([[1,2],[3]])','1,2,3'],
 ['function f(){return 1;}','f+""','function f(){return 1;}'],['','({})==({})',false],['function f(){}function g(){}','f==g',false],['function run(){var x={};return x==x;}','run()',true],['function f(){}','f.prototype+"x"','[object Object]x']
]){assert.deepEqual(evaluate(source,expression),expected);passed++;}
for(const [source,expression,code] of [
 ['','String({toString:function(){throw Error("never");}})','ast_custom_coercion_unsupported'],['','+{valueOf:1}','ast_custom_coercion_unsupported'],
 ['function run(){var a=[1];a.join=function(){throw Error("never");};return String(a);}','run()','ast_custom_coercion_unsupported'],
 ['function f(){}function run(){f.toString=function(){throw Error("never");};return f+"";}','run()','ast_custom_coercion_unsupported'],['','String+""','ast_native_coercion_unsupported'],
 ['function run(){var a=[];a.push(a);return String(a);}','run()','ast_cyclic_coercion_unsupported'],['','String('+Array(10).fill('[').join('')+'1'+Array(10).fill(']').join('')+')','ast_coercion_depth_limit']
]){let blocked;try{evaluate(source,expression);}catch(e){blocked=e;}assert(blocked instanceof model.Fatal);assert.equal(blocked.code,code);passed++;}
const fixture='function table(){var a=["one.fixture.net"];return a;}function _0x5447(i,k){return table()[i];}(function(t){var key="cache:"+t.prototype;t.prototype[key]=1;})(table);const main=["one.fixture.net"],dmca=["two.fixture.net"],rules=["three.fixture.net"];';
const report=model.recover(fixture,{pin:null,limit:30000});assert.deepEqual(report.lists,{main:['one.fixture.net'],dmca:['two.fixture.net'],rules:['three.fixture.net']});passed++;
process.stdout.write(JSON.stringify({passed,total:19}));
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
    source=replace_once(source,"function read(obj,k){tick();k=property(k);",NEW_READ_PREFIX)
    source=replace_once(source,"function primitive(v){if(v!==null&&typeof v==='object')fatal('ast_object_coercion_unsupported');return v;}",NEW_PRIMITIVE)
    source=replace_once(source,"function binary(op,a,b){if(op==='===')return a===b;if(op==='!==')return a!==b;","function binary(op,a,b){if(op==='===')return a===b;if(op==='!==')return a!==b;if((op==='=='||op==='!=')&&a!==null&&b!==null&&typeof a==='object'&&typeof b==='object')return op==='=='?a===b:a!==b;")
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
    report={'status':'not_completed','scope':'Selected source AST operations use unchanged data/step/time limits. Isolated modeled-function prototype data and bounded default coercions are supported; custom conversion hooks and native/host coercions stay blocked. No eval or Function, browser, destination requests or playback.'}
    private={}
    try:
        report['base_self_test']=check_tests('test_bounded_route_decoder.cjs',47)
        original=(HERE/'bounded_route_decoder.cjs').read_text(encoding='utf-8')
        patched=instrument(original)
        with tempfile.TemporaryDirectory(prefix='kofum-bounded-coercion-') as directory:
            directory=Path(directory)
            helper=directory/'bounded_route_decoder.cjs';helper.write_text(patched,encoding='utf-8');helper.chmod(0o600)
            tests=directory/'test_bounded_route_decoder.cjs';tests.write_bytes((HERE/'test_bounded_route_decoder.cjs').read_bytes());tests.chmod(0o600)
            probes=directory/'probe_rejected_access.cjs';probes.write_text(PROBES,encoding='utf-8');probes.chmod(0o600)
            prototype=directory/'probe_inert_prototype.cjs';prototype.write_text(PROTOTYPE_PROBES,encoding='utf-8');prototype.chmod(0o600)
            coercion=directory/'probe_default_coercion.cjs';coercion.write_text(COERCION_PROBES,encoding='utf-8');coercion.chmod(0o600)
            report['instrumented_regression_test']=check_tests(tests,47)
            report['rejection_diagnostic_test']=check_tests(probes,5)
            report['prototype_model_test']=check_tests(prototype,11)
            report['coercion_model_test']=check_tests(coercion,19)
            report['self_test']={'passed':82,'total':82,'base_cases':47,'diagnostic_cases':5,'prototype_cases':11,'coercion_cases':19}
            report['prototype_policy']='normal_modeled_function_read_only_inert_object'
            report['coercion_policy']='bounded_plain_object_tag_array_join_source_function_text_no_hooks'
            report['interpreter_provenance']={'repository_sha256':hashlib.sha256(original.encode('utf-8')).hexdigest(),'effective_sha256':hashlib.sha256(patched.encode('utf-8')).hexdigest(),'instrumentation':'inert_prototype_bounded_default_coercion_and_rejection_enums'}
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
                if data.get('phase') in PHASES:report['failure_phase']=data['phase']
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
