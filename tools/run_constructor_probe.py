"""Add enum-only rejected-constructor context to the existing bounded decoder run."""
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
PROBES=r"""
'use strict';
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');let passed=0;
function evaluate(source,expression){const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,30000);m.hoist(ast.body,m.global,true);return m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}
for(const [source,expression,kind,native,callee] of [
 ['function PrivateCtor(a,b){throw Error("must-not-run");}','new PrivateCtor(1,"private-token",null,undefined,true,[],{},PrivateCtor,String)','modeled_function','not_applicable','Identifier'],
 ['','new String("private-token")','modeled_native','String','Identifier'],
 ['const PrivateCtor=1;','new PrivateCtor("private-token")','number','not_applicable','Identifier'],
 ['const bag={PrivateCtor:function(){throw Error("must-not-run");}};','new bag.PrivateCtor("private-token")','modeled_function','not_applicable','MemberExpression']
]){let blocked;try{evaluate(source,expression);}catch(e){blocked=e;}assert(blocked instanceof model.Fatal);assert.equal(blocked.code,'ast_new_unsupported');const info=blocked.blocked_constructor;assert.equal(info.constructor_kind,kind);assert.equal(info.native_name,native);assert.equal(info.callee_kind,callee);assert(!/PrivateCtor|private-token|must-not-run/.test(JSON.stringify(info)));if(info.argument_count===9){assert.equal(info.arguments_truncated,true);assert.equal(info.argument_kinds.length,8);assert.deepEqual(info.argument_kinds,['number','string','null','undefined','boolean','array','object','modeled_function']);}passed++;}
const fixture='function table(){var a=["one.fixture.net"];return a;}function _0x5447(i,k){return table()[i];}function PrivateCtor(){throw Error("never");}(function(t){new PrivateCtor("private-token");})(table);const main=["one.fixture.net"],dmca=["two.fixture.net"],rules=["three.fixture.net"];';
let blocked;try{model.recover(fixture,{pin:null,limit:30000});}catch(e){blocked=e;}assert(blocked instanceof model.Fatal);assert.equal(blocked.code,'ast_new_unsupported');assert.equal(blocked.phase,'rotation');assert.equal(blocked.blocked_constructor.constructor_kind,'modeled_function');passed++;
assert.equal(evaluate('','(new Array(2)).length'),2);passed++;
assert.equal(evaluate('','(new Error("private-message")).message'),'private-message');passed++;
process.stdout.write(JSON.stringify({passed,total:7}));
"""

def patch(source):
    source=previous.replace_once(source,"function fatal(code,detail){const error=new Fatal(code);if(detail)error.blocked_access=detail;throw error;}","function fatal(code,detail){const error=new Fatal(code);if(detail){if(code==='ast_new_unsupported')error.blocked_constructor=detail;else error.blocked_access=detail;}throw error;}")
    source=previous.replace_once(source,'function machine(source,limit=100000000){',EVIDENCE+'\nfunction machine(source,limit=100000000){')
    source=previous.replace_once(source,"if(n.type==='NewExpression'&&(!(fn instanceof Native)||!['Array','Error'].includes(fn.name)))fatal('ast_new_unsupported');","if(n.type==='NewExpression'&&(!(fn instanceof Native)||!['Array','Error'].includes(fn.name)))fatal('ast_new_unsupported',constructorEvidence(fn,a,n.callee));")
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
        with tempfile.TemporaryDirectory(prefix='kofum-constructor-context-') as directory:
            directory=Path(directory)
            helper=directory/'bounded_route_decoder.cjs';helper.write_text(prepared,encoding='utf-8');helper.chmod(0o600)
            probes=directory/'probe_constructor_context.cjs';probes.write_text(PROBES,encoding='utf-8');probes.chmod(0o600)
            code,tests=original_invoke(probes,timeout=30)
            if code or tests.get('passed')!=7 or tests.get('total')!=7:raise RuntimeError('constructor_context_test_failed')
        previous.instrument,previous.invoke=instrument,invoke
        report=previous.run()
        report['constructor_context_test']={'passed':7,'total':7}
        base=report.get('self_test',{})
        if base.get('passed')==82 and base.get('total')==82:
            report['self_test']={**base,'passed':89,'total':89,'constructor_cases':7}
        report['constructor_diagnostics']='enum_only_rejection_before_invoke'
        if isinstance(report.get('interpreter_provenance'),dict):report['interpreter_provenance']['constructor_context']='enum_only_before_invoke'
        rejection=state.get('rejection')
        if report.get('code')=='ast_new_unsupported' and rejection and report.get('main_script_sha256')==rejection['source_sha256']:
            report['constructor_rejection']=rejection['detail']
        if state.get('instrumentation_failed'):report['status']='inspection_failed';report['code']='constructor_instrumentation_shape_changed'
        return report
    except Exception:
        return {'status':'inspection_failed','code':'constructor_context_setup_or_test_failed','scope':'Constructor guard remains unchanged; no constructor is enabled by this adapter.'}
    finally:
        previous.instrument,previous.invoke=original_instrument,original_invoke

if __name__=='__main__':
    TARGET.parent.mkdir(exist_ok=True)
    TARGET.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    TARGET.write_text(json.dumps(run(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
