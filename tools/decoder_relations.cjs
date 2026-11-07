"use strict";
const fs=require('node:fs'),acorn=require('internal/deps/acorn/acorn/dist/acorn');
const ROOT='_0x5447',METHODS=new Set(['charCodeAt','fromCharCode','decodeURIComponent','atob','push','shift','split','join','parseInt','includes','indexOf']);
function fail(code){throw Error(code);}
function walk(root,visit){const stack=[root];let count=0;while(stack.length){const n=stack.pop();if(++count>100000)fail('relation_ast_limit');visit(n);for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')stack.push(c);}else if(v&&typeof v.type==='string')stack.push(v);}}}
function constant(n,env=new Map(),depth=0){
 if(!n||depth>16)fail('relation_nonconstant');let v;
 if(n.type==='Literal'&&(n.value===null||['string','number','boolean'].includes(typeof n.value)))v=n.value;
 else if(n.type==='Identifier'&&env.has(n.name))v=env.get(n.name);
 else if(n.type==='UnaryExpression'){const a=constant(n.argument,env,depth+1);if(n.operator==='-')v=-a;else if(n.operator==='+')v=+a;else if(n.operator==='~')v=~a;else if(n.operator==='!')v=!a;else fail('relation_nonconstant');}
 else if(n.type==='BinaryExpression'){
  const a=constant(n.left,env,depth+1),b=constant(n.right,env,depth+1);
  switch(n.operator){case '+':v=a+b;break;case '-':v=a-b;break;case '*':v=a*b;break;case '/':v=a/b;break;case '%':v=a%b;break;case '^':v=a^b;break;case '&':v=a&b;break;case '|':v=a|b;break;case '<<':v=a<<b;break;case '>>':v=a>>b;break;case '>>>':v=a>>>b;break;default:fail('relation_nonconstant');}
 }else fail('relation_nonconstant');
 if(typeof v==='string'&&v.length>8192||typeof v==='number'&&!Number.isFinite(v))fail('relation_nonconstant');return v;
}
function kind(n,env){try{const v=constant(n,env);return v===null?'null':typeof v==='number'?(Number.isInteger(v)?'integer':'number'):typeof v;}catch(_){return 'nonconstant';}}
function key(n){if(!n||n.type!=='MemberExpression')return null;try{const v=n.computed?constant(n.property):n.property.name;return METHODS.has(v)?v:null;}catch(_){return null;}}
function signals(node){const known={},loops={};let rotations=0,unknown=0;
 walk(node,n=>{
  if(['ForStatement','WhileStatement','DoWhileStatement'].includes(n.type))loops[n.type]=(loops[n.type]||0)+1;
  if(n.type!=='CallExpression')return;const method=n.callee.type==='Identifier'&&METHODS.has(n.callee.name)?n.callee.name:key(n.callee);
  if(method)known[method]=(known[method]||0)+1;else unknown++;
  if(method==='push'&&n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&n.arguments.length===1){const a=n.arguments[0];if(a.type==='CallExpression'&&!a.arguments.length&&key(a.callee)==='shift'&&a.callee.object.type==='Identifier'&&a.callee.object.name===n.callee.object.name)rotations++;}
 });return {recognized_call_syntax:known,unknown_call_count:unknown,loops,push_shift_same_identifier_patterns:rotations};
}
function shapeInspector(ast,functions){
 const definitions=new Map(),assignments=new Map();
 walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){const list=definitions.get(n.id.name)||[];list.push(n.init);definitions.set(n.id.name,list);}if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'||n.type==='UpdateExpression'&&n.argument.type==='Identifier'){const name=n.type==='AssignmentExpression'?n.left.name:n.argument.name;assignments.set(name,(assignments.get(name)||0)+1);}});
 return function describe(root){
  let remaining=64;
  function shape(n,depth=0,params=new Map()){
   if(!n)return {type:'missing'};
   if(depth>7||--remaining<0)return {type:n.type,truncated:true};
   const out={type:n.type},next=x=>shape(x,depth+1,params);
   if(n.type==='Literal')out.value_kind=n.regex?'regexp':n.value===null?'null':typeof n.value;
   else if(n.type==='Identifier'){
    out.role=params.has(n.name)?'parameter_'+params.get(n.name):n.name===ROOT?'decoder_name_match':functions.has(n.name)?'function_name_match':'identifier_redacted';
    if(!params.has(n.name)){const defs=definitions.get(n.name)||[];out.binding_evidence={variable_declarations:defs.length,identifier_writes:assignments.get(n.name)||0,function_declarations:(functions.get(n.name)||[]).length};if(defs.length===1&&defs[0]){out.binding_evidence.initializer_type=defs[0].type;if(defs[0].type==='Identifier')out.binding_evidence.initializer_role=defs[0].name===ROOT?'decoder_name_match':'identifier_redacted';if(defs[0].type==='ObjectExpression')out.binding_evidence.object_property_count=defs[0].properties.length;}}
   }else if(n.type==='CallExpression'||n.type==='NewExpression'){
    out.callee=next(n.callee);out.argument_count=n.arguments.length;out.arguments=n.arguments.slice(0,8).map(next);if(n.arguments.length>8)out.arguments_truncated=true;
   }else if(n.type==='MemberExpression'){
    out.computed=n.computed;out.object=next(n.object);out.property=n.computed?next(n.property):{type:n.property.type,role:'property_name_redacted'};const method=key(n);if(method)out.recognized_method_syntax=method;
   }else if(n.type==='BinaryExpression'||n.type==='LogicalExpression'){out.operator=n.operator;out.left=next(n.left);out.right=next(n.right);}
   else if(n.type==='UnaryExpression'||n.type==='UpdateExpression'){out.operator=n.operator;out.argument=next(n.argument);}
   else if(n.type==='ConditionalExpression'){out.test=next(n.test);out.consequent=next(n.consequent);out.alternate=next(n.alternate);}
   else if(n.type==='SequenceExpression'){out.expression_count=n.expressions.length;out.expressions=n.expressions.slice(0,8).map(next);if(n.expressions.length>8)out.expressions_truncated=true;}
   else if(n.type==='TemplateLiteral'){out.expression_count=n.expressions.length;out.expressions=n.expressions.slice(0,8).map(next);if(n.expressions.length>8)out.expressions_truncated=true;}
   else if(n.type==='ArrayExpression'){out.element_count=n.elements.length;out.elements=n.elements.slice(0,8).map(next);if(n.elements.length>8)out.elements_truncated=true;}
   else if(n.type==='FunctionExpression'||n.type==='ArrowFunctionExpression'){
    out.parameter_count=n.params.length;const child=new Map(params);n.params.forEach((p,i)=>{if(p.type==='Identifier')child.set(p.name,i+1);});
    if(n.body.type!=='BlockStatement')out.return_expression=shape(n.body,depth+1,child);
    else{out.statement_count=n.body.body.length;if(n.body.body.length===1&&n.body.body[0].type==='ReturnStatement')out.return_expression=shape(n.body.body[0].argument,depth+1,child);}
   }else if(n.type==='ObjectExpression')out.property_count=n.properties.length;
   else if(n.type==='ChainExpression'||n.type==='SpreadElement')out.expression=next(n.expression||n.argument);
   return out;
  }
  return shape(root);
 };
}
function analyze(source){
 if(Buffer.byteLength(source,'utf8')>3000000)fail('relation_input_limit');let ast;try{ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});}catch(_){fail('relation_parse_failed');}
 const functions=new Map(),otherBindings=new Set(),assigned=new Set();
 walk(ast,n=>{if(n.type==='FunctionDeclaration'&&n.id){const a=functions.get(n.id.name)||[];a.push(n);functions.set(n.id.name,a);}if(n.type==='VariableDeclarator'&&n.id.type==='Identifier')otherBindings.add(n.id.name);if(/Function/.test(n.type))for(const p of n.params)if(p.type==='Identifier')otherBindings.add(p.name);if(n.type==='AssignmentExpression'&&n.left.type==='Identifier')assigned.add(n.left.name);});
 const roots=functions.get(ROOT)||[];
 if(roots.length!==1||otherBindings.has(ROOT))return {status:'decoder_relationships_unavailable',code:'central_declaration_missing_or_ambiguous'};
 const central=roots[0],providers=[],describe=shapeInspector(ast,functions);
 walk(central.body,n=>{
  if(n.type!=='CallExpression'||n.callee.type!=='Identifier'||providers.some(p=>p.name===n.callee.name)||providers.length>=8)return;
  const matches=functions.get(n.callee.name)||[];if(matches.length!==1||n.callee.name===ROOT)return;
  const fn=matches[0],arrays=[];walk(fn.body,a=>{if(a.type==='VariableDeclarator'&&a.id.type==='Identifier'&&a.init&&a.init.type==='ArrayExpression'&&a.init.elements.length&&a.init.elements.every(x=>x&&x.type==='Literal'&&typeof x.value==='string'))arrays.push({name:a.id.name,size:a.init.elements.length});});
  if(!arrays.length)return;let replacement=false;
  walk(fn.body,a=>{if(a.type!=='AssignmentExpression'||a.operator!=='='||a.left.type!=='Identifier'||a.left.name!==fn.id.name||a.right.type!=='FunctionExpression'||a.right.params.length||a.right.body.body.length!==1)return;const r=a.right.body.body[0];if(r.type==='ReturnStatement'&&r.argument&&r.argument.type==='Identifier'&&arrays.some(x=>x.name===r.argument.name))replacement=true;});
  providers.push({name:fn.id.name,node:fn,summary:{role:'table_candidate_'+(providers.length+1),parameter_count:fn.params.length,literal_string_array_count:arrays.length,literal_string_array_sizes:arrays.slice(0,8).map(a=>a.size),self_replacement_returns_array_identifier_pattern:replacement}});
 });
 function traceKind(call){
  if(call.type!=='CallExpression'||call.callee.type!=='Identifier')return {kind:'other_expression'};
  if(call.callee.name===ROOT)return {kind:'direct_decoder_call',argument_kinds:call.arguments.slice(0,8).map(n=>kind(n))};
  const matches=functions.get(call.callee.name)||[];
  if(matches.length!==1||otherBindings.has(call.callee.name)||assigned.has(call.callee.name))return {kind:'unresolved_call'};
  const fn=matches[0];if(fn.params.length>5||fn.params.length!==call.arguments.length||fn.params.some(x=>x.type!=='Identifier')||fn.body.body.length!==1)return {kind:'unresolved_call'};
  const r=fn.body.body[0],c=r.argument;
  if(r.type!=='ReturnStatement'||!c||c.type!=='CallExpression'||c.callee.type!=='Identifier'||c.callee.name!==ROOT)return {kind:'unresolved_call'};
  try{const env=new Map(fn.params.map((p,i)=>[p.name,constant(call.arguments[i])]));return {kind:'single_return_forwarder_candidate',argument_kinds:c.arguments.slice(0,8).map(n=>kind(n,env))};}catch(_){return {kind:'forwarder_nonconstant_arguments'};}
 }
 function trace(call){return Object.assign({expression:describe(call)},traceKind(call));}
 const routes={main:{binding_write_count:0,initializers:[],method_call_syntax:{},method_call_shapes:[]},dmca:{binding_write_count:0,initializers:[],method_call_syntax:{},method_call_shapes:[]},rules:{binding_write_count:0,initializers:[],method_call_syntax:{},method_call_shapes:[]}};
 walk(ast,n=>{
  let name,value;if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){name=n.id.name;value=n.init;}else if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'){name=n.left.name;value=n.right;}
  if(Object.hasOwn(routes,name)){const out=routes[name];out.binding_write_count++;if(value&&out.initializers.length<4){const item={type:value.type};if(value.type==='ArrayExpression'){item.element_count=value.elements.length;item.element_relationships=value.elements.slice(0,100).map(x=>x?trace(x):{kind:'array_hole'});}out.initializers.push(item);}}
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&Object.hasOwn(routes,n.callee.object.name)){const route=routes[n.callee.object.name],out=route.method_call_syntax,k=key(n.callee)||'unknown';out[k]=(out[k]||0)+1;if(route.method_call_shapes.length<4)route.method_call_shapes.push(describe(n));}
 });
 const iifes=[];walk(ast,n=>{if(n.type!=='CallExpression'||!['FunctionExpression','ArrowFunctionExpression'].includes(n.callee.type)||iifes.length>=12)return;const roles=n.arguments.map(a=>a.type==='Identifier'?providers.find(p=>p.name===a.name):null).filter(Boolean).map(p=>p.summary.role);if(roles.length)iifes.push({table_candidate_argument_roles:roles,body_signals:signals(n.callee.body)});});
 return {status:'decoder_relationships_observed',decoder_signals:signals(central.body),table_candidates:providers.map(p=>p.summary),table_argument_iife_candidates:iifes,routes,expression_shape_limits:{expanded_nodes_per_expression:64,max_depth:7,arguments_per_call:8},scope:'Syntactic relationships only, not proof of binding identity, execution order, immutability, decryption or runtime routing. No source values, keys, indices, identifiers or URLs published; no source functions invoked.'};
}
function selfTest(){let passed=0;const check=x=>{if(!x)fail('relation_fixture_failed');passed++;};
 const table='function privateTable(){var privateArray=["secret-one","secret-two"];privateTable=function(){return privateArray;};return privateTable();}';
 const root='function _0x5447(index,key){var a=privateTable();return key.charCodeAt(index)^1;}';
 const fixture=table+root+'function bridge(a,b){return _0x5447(a-1,b);}const main=[bridge(3,"private-token")],dmca=[_0x5447(1,"private-key")],rules=[];rules.includes("private-domain");(function(t){var a=t();for(var i=0;i<2;i++)a.push(a.shift());})(privateTable);';
 const r=analyze(fixture),text=JSON.stringify(r);
 check(r.status==='decoder_relationships_observed');check(r.table_candidates.length===1);check(r.table_candidates[0].literal_string_array_sizes[0]===2);check(r.table_candidates[0].self_replacement_returns_array_identifier_pattern);
 check(r.routes.main.initializers[0].element_relationships[0].kind==='single_return_forwarder_candidate');check(r.routes.main.initializers[0].element_relationships[0].argument_kinds.join(',')==='integer,string');check(r.routes.dmca.initializers[0].element_relationships[0].kind==='direct_decoder_call');check(r.routes.rules.method_call_syntax.includes===1);
 check(r.table_argument_iife_candidates[0].body_signals.push_shift_same_identifier_patterns===1);check(r.decoder_signals.recognized_call_syntax.charCodeAt===1);check(!/secret-one|secret-two|private-token|private-key|private-domain|privateArray|privateTable|bridge/.test(text));
 const expression=acorn.parse('a["pu"+"sh"](a["sh"+"ift"]());',{ecmaVersion:'latest'});check(signals(expression).push_shift_same_identifier_patterns===1);
 const other=acorn.parse('a.push(b.shift());',{ecmaVersion:'latest'});check(signals(other).push_shift_same_identifier_patterns===0);
 check(analyze('function _0x5447(){}function _0x5447(){}').status==='decoder_relationships_unavailable');check(analyze('const x=1;').status==='decoder_relationships_unavailable');
 check(analyze(table+root+'function bridge(a,b){throw Error("never");return _0x5447(a,b);}const main=[bridge(1,"private")];').routes.main.initializers[0].element_relationships[0].kind==='unresolved_call');
 check(analyze(table+root+'function bridge(a,b){return _0x5447(a,b);}const main=[bridge(fetch("/private"),"key")];').routes.main.initializers[0].element_relationships[0].kind==='forwarder_nonconstant_arguments');
 delete globalThis.__relation_marker;analyze('globalThis.__relation_marker=true;'+fixture);check(globalThis.__relation_marker===undefined);
 let rejected=false;try{analyze('function _0x5447(');}catch(e){rejected=e.message==='relation_parse_failed';}check(rejected);
 const sample=e=>analyze(table+root+'const main=['+e+'];').routes.main.initializers[0].element_relationships[0].expression;
 const cases=[['"secret-url"','Literal'],['"secret-prefix"+_0x5447(1,"secret-key")','BinaryExpression'],['privateObject["secret-method"](1,"secret-key")','CallExpression'],['privateObject["secret-property"]','MemberExpression'],['`secret-${_0x5447(1,"secret-key")}`','TemplateLiteral'],['(1,_0x5447(1,"secret-key"))','SequenceExpression'],['flag?_0x5447(1,"secret-key"):"secret-fallback"','ConditionalExpression'],['((x)=>_0x5447(x,"secret-key"))(1)','CallExpression'],['!_0x5447(1,"secret-key")','UnaryExpression']];
 for(const [e,type] of cases){const out=sample(e);check(out.type===type&&!/secret-|privateObject/.test(JSON.stringify(out)));}
 check(sample('"secret-prefix"+_0x5447(1,"secret-key")').right.callee.role==='decoder_name_match');
 check(sample('privateObject["secret-property"]').property.value_kind==='string');
 check(JSON.stringify(sample(Array(30).fill('"secret-prefix"+').join('')+'_0x5447(1,"secret-key")')).includes('"truncated":true'));
 const bound=analyze(table+root+'const privateObject={get secret(){throw Error("never");}};const main=[privateObject["secret"]];').routes.main.initializers[0].element_relationships[0].expression;
 check(bound.object.binding_evidence.initializer_type==='ObjectExpression'&&!JSON.stringify(bound).includes('secret'));
 check(r.routes.rules.method_call_shapes[0].callee.recognized_method_syntax==='includes');
 delete globalThis.__shape_marker;analyze(table+root+'const privateObject={get secret(){globalThis.__shape_marker=true;return "private";}};const main=[privateObject.secret];');check(globalThis.__shape_marker===undefined);
 return {passed,total:19+cases.length+6,scope:'Synthetic relationships, bounded expression shapes, redaction and no-source-execution tests.'};}
try{process.stdout.write(JSON.stringify(process.argv.includes('--self-test')?selfTest():analyze(fs.readFileSync(0,'utf8'))));}catch(error){process.stdout.write(JSON.stringify({status:'analysis_failed',code:/^relation_[a-z_]+$/.test(error.message)?error.message:'relation_analysis_failed'}));process.exitCode=1;}
