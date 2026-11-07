"""Construct data instances of ordinary modeled functions, retaining native escape rejection."""
import hashlib
import json
import tempfile
from pathlib import Path
import run_bounded_decoder as previous

HERE=Path(__file__).parent
TARGET=Path('analysis/bounded-decoder-report.json')
KINDS={'modeled_function','modeled_native','object','array','string','number','boolean','undefined','null','other'}
NATIVES={'String','Number','Boolean','Array','Error','parseInt','decodeURIComponent','encodeURIComponent','fromCharCode','other_native','not_applicable'}
CALLEES={'Identifier','MemberExpression','CallExpression','FunctionExpression','SequenceExpression','ConditionalExpression','LogicalExpression','ThisExpression','ChainExpression','NewExpression','Literal','other_expression'}
EVIDENCE=r"""function constructorEvidence(fn,args,callee){const kind=v=>v instanceof Fn?'modeled_function':v instanceof Native?'modeled_native':v instanceof Obj?'object':Array.isArray(v)?'array':v===null?'null':['string','number','boolean','undefined'].includes(typeof v)?typeof v:'other';const names=['String','Number','Boolean','Array','Error','parseInt','decodeURIComponent','encodeURIComponent','fromCharCode'];const types=['Identifier','MemberExpression','CallExpression','FunctionExpression','SequenceExpression','ConditionalExpression','LogicalExpression','ThisExpression','ChainExpression','NewExpression','Literal'];const out={constructor_kind:kind(fn),native_name:fn instanceof Native?(names.includes(fn.name)?fn.name:'other_native'):'not_applicable',callee_kind:types.includes(callee.type)?callee.type:'other_expression',argument_count:args.length,argument_kinds:args.slice(0,8).map(kind),arguments_truncated:args.length>8};if(fn instanceof Fn){out.function_signature={node_type:['FunctionDeclaration','FunctionExpression'].includes(fn.node.type)?fn.node.type:'other_modeled_function',parameter_count:fn.node.params.length,async:!!fn.node.async,generator:!!fn.node.generator};}return out;}"""
MODELED_HELPERS=r"""
function modeledOwner(object,key){const seen=new Set();let current=object,depth=0;while(current instanceof Obj){tick();if(seen.has(current)||++depth>8)fatal('ast_model_prototype_limit');seen.add(current);if(current.p.has(key))return current;current=modeledParents.get(current);}return null;}
function constructModeled(fn,args,callee){tick();if(!(fn instanceof Fn)||!fn.node||!['FunctionDeclaration','FunctionExpression'].includes(fn.node.type)||fn.node.async||fn.node.generator)fatal('ast_new_unsupported',constructorEvidence(fn,args,callee));const proto=read(fn,'prototype');if(!(proto instanceof Obj)||proto instanceof Fn)fatal('ast_constructor_prototype_unsupported');if(++allocations>10000)fatal('ast_allocation_limit');const instance=new Obj();modeledParents.set(instance,proto);const result=invoke(fn,args,instance);if(result!==null&&typeof result==='object'){if(result instanceof Obj||Array.isArray(result)||result instanceof Native)return result;fatal('ast_constructor_result_unsupported');}if(result==null||['string','number','boolean','undefined'].includes(typeof result))return instance;fatal('ast_constructor_result_unsupported');}
"""
PROBES=r"""
'use strict';
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');let passed=0;
function evaluate(source,expression,limit=50000){const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,limit);m.hoist(ast.body,m.global,true);return m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}
const positives=[
 ['function C(v){this.value=v;}','(new C(7)).value',7],
 ['function C(v){this.value=v;}function run(){var a=new C(1),b=new C(2);a.value=9;return b.value;}','run()',2],
 ['function C(fn){this.value=fn(3);}function cb(v){return v+1;}','(new C(cb)).value',4],
 ['function C(v){this.value=v;}function run(){C.prototype.read=function(){return this.value;};return (new C(5)).read();}','run()',5],
 ['function C(){return {value:11};}','(new C()).value',11],
 ['function C(){return [12];}','(new C())[0]',12],
 ['function C(){return function(){return 13;};}','(new C())()',13],
 ['function C(){this.value=4;return 99;}','(new C()).value',4],
 ['function C(){this.value=4;return null;}','(new C()).value',4],
 ['function C(){}function run(){C.prototype.mark=1;return "mark" in new C();}','run()',true],
 ['function C(){}function run(){C.prototype.mark=1;return (new C()).hasOwnProperty("mark");}','run()',false],
 ['function C(){}function run(){C.prototype.cache=1;var a=new C(),b=new C();a.cache=2;return b.cache;}','run()',1],
 ['function C(cb){this.cb=cb;}function run(){var a=new C(function(v){return v*2;});return a.cb(3);}','run()',6],
 ['function C(){this.marker=2;}function run(){var a=new C();return this.marker;}','run()',undefined],
 ['function C(){this.value=arguments[0];}','(new C(8)).value',8]
];
for(const [source,expression,expected] of positives){assert.deepEqual(evaluate(source,expression),expected);passed++;}
const negatives=[
 ['','new String("private-token")','ast_new_unsupported'],['','new Number(1)','ast_new_unsupported'],
 ['async function C(){}','new C()','ast_new_unsupported'],['function* C(){}','new C()','ast_new_unsupported'],
 ['function C(){}','(new C()).constructor','ast_property_forbidden'],['function C(){}','(new C()).__proto__','ast_property_forbidden'],
 ['function C(){this.x=require("node:fs");}','new C()','ast_name_forbidden'],
 ['function C(){}function run(){C.prototype.toString=function(){throw Error("never");};return String(new C());}','run()','ast_custom_coercion_unsupported'],
 ['function C(){}function run(){C.prototype.valueOf=function(){throw Error("never");};return +new C();}','run()','ast_custom_coercion_unsupported'],
 ['function C(){while(true){}}','new C()','ast_budget_exceeded',500],
 ['function C(){try{process;}catch(e){return {};}}','new C()','ast_name_forbidden'],
 ['function C(){this.x=new RegExp("private-pattern");}','new C()','ast_missing_regexp_intrinsic']
];
for(const [source,expression,code,limit] of negatives){let blocked;try{evaluate(source,expression,limit);}catch(e){blocked=e;}assert(blocked instanceof model.Fatal);assert.equal(blocked.code,code);passed++;}
const fixture='function table(){var a=["one.fixture.net"];return a;}function _0x5447(i,k){return table()[i];}function Box(cb){this.cb=cb;}(function(t){Box.prototype.load=function(){return this.cb();};var b=new Box(t);if(b.load()[0]!=="one.fixture.net")throw "wrong";})(table);const main=["one.fixture.net"],dmca=["two.fixture.net"],rules=["three.fixture.net"];';
assert.deepEqual(model.recover(fixture,{pin:null,limit:50000}).lists,{main:['one.fixture.net'],dmca:['two.fixture.net'],rules:['three.fixture.net']});passed++;
let native;try{evaluate('','new String("private-token")');}catch(e){native=e;}assert.equal(native.blocked_constructor.native_name,'String');assert(!JSON.stringify(native.blocked_constructor).includes('private-token'));passed++;
let noncallable;try{evaluate('','new (1)()');}catch(e){noncallable=e;}assert.equal(noncallable.blocked_constructor.constructor_kind,'number');passed++;
assert.equal(evaluate('','(new Array(2)).length'),2);passed++;
assert.equal(evaluate('','(new Error("private-message")).message'),'private-message');passed++;
process.stdout.write(JSON.stringify({passed,total:positives.length+negatives.length+5}));
"""

def patch(source):
    source=previous.replace_once(source,"function fatal(code,detail){const error=new Fatal(code);if(detail)error.blocked_access=detail;throw error;}","function fatal(code,detail){const error=new Fatal(code);if(detail){if(code==='ast_new_unsupported')error.blocked_constructor=detail;else error.blocked_access=detail;}throw error;}")
    source=previous.replace_once(source,'function machine(source,limit=100000000){',EVIDENCE+'\nfunction machine(source,limit=100000000){\n const modeledParents=new WeakMap();\n'+MODELED_HELPERS)
    source=previous.replace_once(source,"if(obj instanceof Obj){if(obj.p.has(k))return obj.p.get(k);","if(obj instanceof Obj){const owner=modeledOwner(obj,k);if(owner)return owner.p.get(k);")
    source=previous.replace_once(source,"return b instanceof Obj?b.p.has(k):","return b instanceof Obj?!!modeledOwner(b,k):")
    source=previous.replace_once(source,"if(fields.has('toString')||fields.has('valueOf')||Array.isArray(v)&&fields.has('join'))fatal('ast_custom_coercion_unsupported');","if(v instanceof Obj?(!!modeledOwner(v,'toString')||!!modeledOwner(v,'valueOf')):(fields.has('toString')||fields.has('valueOf')||fields.has('join')))fatal('ast_custom_coercion_unsupported');")
    source=previous.replace_once(source,"if(n.type==='NewExpression'&&(!(fn instanceof Native)||!['Array','Error'].includes(fn.name)))fatal('ast_new_unsupported');","if(n.type==='NewExpression'&&(!(fn instanceof Native)||!['Array','Error'].includes(fn.name)))return constructModeled(fn,a,n.callee);")
    source=previous.replace_once(source,"if(!owner)fatal('ast_name_unavailable');","if(!owner)fatal(['RegExp','Math','Object','Date','JSON'].includes(name)?'ast_missing_'+name.toLowerCase()+'_intrinsic':'ast_name_unavailable');")
    source=previous.replace_once(source,'blocked_access:e instanceof Fatal?e.blocked_access:undefined','blocked_access:e instanceof Fatal?e.blocked_access:undefined,blocked_constructor:e instanceof Fatal?e.blocked_constructor:undefined')
    return source

def clean_constructor(data):
    item=data.get('blocked_constructor')
    if not isinstance(item,dict):return None
    if item.get('constructor_kind') not in KINDS or item.get('native_name') not in NATIVES or item.get('callee_kind') not in CALLEES:return None
    count=item.get('argument_count');kinds=item.get('argument_kinds')
    if type(count) is not int or not 0<=count<=32 or not isinstance(kinds,list) or len(kinds)!=min(count,8) or any(x not in KINDS for x in kinds):return None
    if type(item.get('arguments_truncated')) is not bool or item['arguments_truncated']!=(count>8):return None
    clean={key:item[key] for key in ('constructor_kind','native_name','callee_kind','argument_count','argument_kinds','arguments_truncated')}
    if item['constructor_kind']=='modeled_function':
        sig=item.get('function_signature')
        if not isinstance(sig,dict) or sig.get('node_type') not in {'FunctionDeclaration','FunctionExpression','other_modeled_function'}:return None
        if type(sig.get('parameter_count')) is not int or not 0<=sig['parameter_count']<=100000 or type(sig.get('async')) is not bool or type(sig.get('generator')) is not bool:return None
        clean['function_signature']={key:sig[key] for key in ('node_type','parameter_count','async','generator')}
    clean['phase']=data.get('phase') if data.get('phase') in previous.PHASES else 'unclassified'
    return clean

def run():
    original_instrument,original_invoke=previous.instrument,previous.invoke
    state={}
    def instrument(source):
        try:return patch(original_instrument(source))
        except Exception:
            state['instrumentation_failed']=True
            raise
    def invoke(filename,source='',timeout=60):
        code,data=original_invoke(filename,source,timeout)
        if Path(filename).name=='bounded_route_decoder.cjs' and source and data.get('code')=='ast_new_unsupported':
            clean=clean_constructor(data)
            if clean:state['rejection']={'source_sha256':hashlib.sha256(source.encode('utf-8')).hexdigest(),'detail':clean}
        return code,data
    try:
        prepared=instrument((HERE/'bounded_route_decoder.cjs').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory(prefix='kofum-modeled-constructor-') as directory:
            directory=Path(directory)
            helper=directory/'bounded_route_decoder.cjs';helper.write_text(prepared,encoding='utf-8');helper.chmod(0o600)
            probes=directory/'probe_modeled_constructor.cjs';probes.write_text(PROBES,encoding='utf-8');probes.chmod(0o600)
            code,tests=original_invoke(probes,timeout=30)
            if code or tests.get('passed')!=32 or tests.get('total')!=32:raise RuntimeError('modeled_constructor_test_failed')
        previous.instrument,previous.invoke=instrument,invoke
        report=previous.run()
        report['modeled_constructor_test']={'passed':32,'total':32}
        base=report.get('self_test',{})
        if base.get('passed')==82 and base.get('total')==82:
            report['self_test']={**base,'passed':114,'total':114,'constructor_cases':32}
        report['constructor_policy']='ordinary_modeled_functions_isolated_this_private_data_parent_map'
        report['constructor_diagnostics']='enum_only_for_remaining_rejections'
        report['scope']=report.get('scope','')+' Ordinary modeled-function construction uses isolated this, bounded private data-prototype lookup and interpreter-only invocation. Inherited conversion hooks stay blocked; no additional native constructor is enabled.'
        if isinstance(report.get('interpreter_provenance'),dict):report['interpreter_provenance']['constructor_model']='ordinary_fn_data_instances_private_parent_map'
        rejection=state.get('rejection')
        if report.get('code')=='ast_new_unsupported' and rejection and report.get('main_script_sha256')==rejection['source_sha256']:
            report['constructor_rejection']=rejection['detail']
        if state.get('instrumentation_failed'):report['status']='inspection_failed';report['code']='modeled_constructor_instrumentation_shape_changed'
        return report
    except Exception:
        return {'status':'inspection_failed','code':'modeled_constructor_setup_or_test_failed','scope':'Only ordinary modeled-function construction is proposed; native escape guards remain unchanged. No live-source success is claimed.'}
    finally:
        previous.instrument,previous.invoke=original_instrument,original_invoke

if __name__=='__main__':
    TARGET.parent.mkdir(exist_ok=True)
    TARGET.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    TARGET.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
