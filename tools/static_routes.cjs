"use strict";
const fs=require('node:fs'),acorn=require('internal/deps/acorn/acorn/dist/acorn');
function fail(code){throw Error(code);}
function walk(root,visit){const stack=[root];let count=0;while(stack.length){const n=stack.pop();if(++count>100000)fail('route_ast_limit');visit(n);for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')stack.push(c);}else if(v&&typeof v.type==='string')stack.push(v);}}}
function domain(s){return typeof s==='string'&&s.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)&&!/(?:^|\.)(?:local|localhost|internal|test|invalid|example)$/.test(s);}
function profile(fn){
 const types={},operators={},calls={};let literalStrings=0,arrays=0,functions=0;
 walk(fn.body,n=>{types[n.type]=(types[n.type]||0)+1;if(n.type==='Literal'&&typeof n.value==='string')literalStrings++;if(n.type==='ArrayExpression')arrays++;if(/Function/.test(n.type))functions++;if(['+','-','*','/','%','^','&','|','<<','>>','>>>','!','~','===','!==','==','!=','<','>','<=','>=','&&','||','??','='].includes(n.operator))operators[n.operator]=(operators[n.operator]||0)+1;if(n.type==='CallExpression'){const key=n.callee.type;calls[key]=(calls[key]||0)+1;}});
 return {parameter_count:fn.params.length,node_types:types,operators,callee_types:calls,string_literal_count:literalStrings,array_literal_count:arrays,nested_function_count:functions};
}
function analyze(source){
 if(Buffer.byteLength(source,'utf8')>3000000)fail('route_input_limit');let ast;try{ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});}catch(_){fail('route_parse_failed');}
 const parents=new WeakMap(),defs=new Map(),writes=new Map(),mutations=new Set(),escapes=new Set(),functions=new Map();
 walk(ast,n=>{for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')parents.set(c,n);}else if(v&&typeof v.type==='string')parents.set(v,n);}});
 const write=name=>writes.set(name,(writes.get(name)||0)+1);
 const root=n=>{while(n&&n.type==='MemberExpression')n=n.object;return n&&n.type==='Identifier'?n.name:null;};
 let dynamicScope=false;
 walk(ast,n=>{
  if(n.type==='VariableDeclarator'&&n.id.type!=='Identifier')dynamicScope=true;
  if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){
   write(n.id.name);const decl=parents.get(n),scope=decl&&parents.get(decl);
   if(n.init&&scope&&['Program','BlockStatement'].includes(scope.type))defs.set(n.id.name,{value:n.init,scope});
   if(n.init&&n.init.type==='Identifier')escapes.add(n.init.name);
  }
  if(n.type==='AssignmentExpression'){
   if(n.left.type==='Identifier')write(n.left.name);else if(n.left.type==='MemberExpression')mutations.add(root(n.left));else dynamicScope=true;
   if(n.right.type==='Identifier')escapes.add(n.right.name);
  }
  if(n.type==='UpdateExpression'){if(n.argument.type==='Identifier')write(n.argument.name);else mutations.add(root(n.argument));}
  if(n.type==='UnaryExpression'&&n.operator==='delete')mutations.add(root(n.argument));
  if(n.type==='CallExpression'||n.type==='NewExpression'){
   for(const arg of n.arguments)if(arg.type==='Identifier')escapes.add(arg.name);
   if(n.callee.type==='Identifier'&&['eval','Function'].includes(n.callee.name))dynamicScope=true;
   if(n.callee.type==='MemberExpression')mutations.add(root(n.callee.object));
  }
  if(n.type==='ReturnStatement'&&n.argument&&n.argument.type==='Identifier')escapes.add(n.argument.name);
  if(n.type==='WithStatement')dynamicScope=true;
  if(['ForInStatement','ForOfStatement'].includes(n.type)){if(n.left.type==='Identifier')write(n.left.name);else if(n.left.type==='MemberExpression')mutations.add(root(n.left));}
  if(n.type==='CatchClause'&&n.param&&n.param.type!=='Identifier')dynamicScope=true;
  if(/Function/.test(n.type)){
   if(n.id){write(n.id.name);if(n.type==='FunctionDeclaration'){const list=functions.get(n.id.name)||[];list.push(n);functions.set(n.id.name,list);}}
   for(const p of n.params)if(p.type==='Identifier')write(p.name);else dynamicScope=true;
  }
  if(n.type==='CatchClause'&&n.param&&n.param.type==='Identifier')write(n.param.name);
 });
 let steps=0;
 function value(n,depth=0,seen=new Set()){
  if(!n||depth>24||++steps>2000)fail('route_resolution_limit');
  const next=x=>value(x,depth+1,seen);
  if(n.type==='Literal'&&typeof n.value==='string'&&n.value.length<=16000)return n.value;
  if(n.type==='BinaryExpression'&&n.operator==='+'){const a=next(n.left),b=next(n.right);if(typeof a!=='string'||typeof b!=='string'||a.length+b.length>16000)fail('route_concat_rejected');return a+b;}
  if(n.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis[0].value.cooked;
  if(n.type==='ArrayExpression'){if(n.elements.length>100)fail('route_array_limit');return n.elements.map(next);}
  if(n.type==='Identifier'){
   const d=defs.get(n.name);if(!d||writes.get(n.name)!==1||mutations.has(n.name)||escapes.has(n.name)||seen.has(n.name)||d.value.end>=n.start||d.scope.start>n.start||d.scope.end<n.end)fail('route_binding_unresolved');
   const chain=new Set(seen);chain.add(n.name);return value(d.value,depth+1,chain);
  }
  fail(n.type==='CallExpression'?'route_call_unresolved':'route_expression_unsupported');
 }
 const lists={};for(const name of ['main','dmca','rules']){
  try{
   if(dynamicScope)fail('route_dynamic_scope');const d=defs.get(name);
   if(!d||writes.get(name)!==1||mutations.has(name)||escapes.has(name))fail('route_binding_unresolved');
   const data=value(d.value);if(!Array.isArray(data)||!data.every(domain))fail('route_domains_rejected');lists[name]={status:'static_domains',domains:[...new Set(data)]};
  }catch(error){lists[name]={status:'unsupported',code:/^route_[a-z_]+$/.test(error.message)?error.message:'route_analysis_failed'};}
 }
 const central=functions.get('_0x5447')||[];const decoder={status:central.length===1?'structure_observed':central.length?'ambiguous':'not_found',declaration_count:central.length};
 if(central.length===1){decoder.structure=profile(central[0]);const visited=new Set(['_0x5447']),queue=[central[0]],dependencies=[];
  while(queue.length&&dependencies.length<12){const fn=queue.shift();walk(fn.body,n=>{if(n.type!=='CallExpression'||n.callee.type!=='Identifier'||visited.has(n.callee.name)||dependencies.length>=12)return;const matches=functions.get(n.callee.name)||[];if(matches.length!==1)return;visited.add(n.callee.name);dependencies.push({role:'dependency_'+(dependencies.length+1),structure:profile(matches[0])});queue.push(matches[0]);});}
  decoder.dependencies=dependencies;
 }
 return {status:Object.values(lists).every(x=>x.status==='static_domains')?'static_route_candidates':'static_resolution_incomplete',lists,decoder,parser_version:acorn.version,scope:'Static candidates and bounded structural counts only. No source functions invoked, no browser, no destination contact, no authorization or playback claim.'};
}
function selfTest(){
 const route=(main,tail='')=>'const main='+main+';const dmca=["media.fixture.net"];const rules=["embed.fixture.net"];'+tail;
 const positives=[route('["one.fixture.net"]'),route('["one."+"fixture.net"]'),route('[`one.fixture.net`]'),'const prefix="one.";'+route('[prefix+"fixture.net"]'),route('[]')];
 const negatives=[route('[decode(1,"private-key")]'),route('["https://secret.fixture.net/?token=private"]'),route('["one.fixture.net"]','main.push("other.fixture.net");'),route('["one.fixture.net"]','consume(main);'),route('["one.fixture.net"]','main[0]="other.fixture.net";'),route('["one.fixture.net"]','const alias=main;'),route('["one.fixture.net"]','eval("ignored");'),'const prefix="one.";prefix="changed";'+route('[prefix+"fixture.net"]'),route('[...other]'),route('[null]'),route('["localhost"]'),route('["one.fixture.net"]','function main(){}'),route('["one.fixture.net"]','for(main of items){}'),route('["one.fixture.net"]','[main]=items;'),route('["one.fixture.net"]','const {x}=obj;'),route('["one.fixture.net"]','function f({x}){}')];
 let passed=0;for(const source of positives){if(analyze(source).status!=='static_route_candidates')fail('route_fixture_failed');passed++;}
 for(const source of negatives){let rejected=false;try{rejected=analyze(source).status==='static_resolution_incomplete';}catch(error){rejected=error.message==='route_parse_failed';}if(!rejected)fail('route_fixture_failed');passed++;}
 const source='function helper(x){return x^1;}function _0x5447(a,b){const privateKey="secret-private-key";return helper(a)+b;}'+route('[_0x5447(1,"private-token")]');const report=analyze(source),text=JSON.stringify(report);
 if(report.decoder.status!=='structure_observed'||report.decoder.dependencies.length!==1||/private-token|secret-private-key|privateKey|helper/.test(text))fail('route_fixture_failed');passed++;
 const ambiguous=analyze('function _0x5447(){}function _0x5447(){}'+route('[]'));if(ambiguous.decoder.status!=='ambiguous')fail('route_fixture_failed');passed++;
 let rejected=false;try{analyze('const main=[');}catch(e){rejected=e.message==='route_parse_failed';}if(!rejected)fail('route_fixture_failed');passed++;
 delete globalThis.__static_route_fixture_marker;analyze(route('["one.fixture.net"]','globalThis.__static_route_fixture_marker=true;'));if(globalThis.__static_route_fixture_marker!==undefined)fail('route_fixture_failed');passed++;
 return {passed,total:positives.length+negatives.length+4,scope:'Synthetic static-resolution, fail-closed and diagnostic-redaction tests only.'};
}
try{process.stdout.write(JSON.stringify(process.argv.includes('--self-test')?selfTest():analyze(fs.readFileSync(0,'utf8'))));}catch(error){process.stdout.write(JSON.stringify({status:'analysis_failed',code:/^route_[a-z_]+$/.test(error.message)?error.message:'route_analysis_failed'}));process.exitCode=1;}
