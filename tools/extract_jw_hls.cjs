"use strict";
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const acorn=require('internal/deps/acorn/acorn/dist/acorn');
function fail(code){throw Error(code);}
function walk(root,visit){const stack=[root];let count=0;while(stack.length){const n=stack.pop();if(++count>100000)fail('jw_ast_limit');visit(n);for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')stack.push(c);}else if(v&&typeof v.type==='string')stack.push(v);}}}
function jwCall(n){return n&&n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name==='jwplayer';}
function field(n,key){if(!n||n.type!=='ObjectExpression'||n.properties.some(p=>p.type!=='Property'||p.computed||p.method||p.kind!=='init'))fail('jw_dynamic_configuration');const found=n.properties.filter(p=>(p.key.name||p.key.value)===key);if(found.length>1)fail('jw_duplicate_property');return found.length?found[0].value:null;}
function hls(value){if(value.length>16000||/[^\x21-\x7e]/.test(value))fail('jw_source_url_rejected');let p;try{p=new URL(value);}catch(_){fail('jw_source_url_rejected');}if(p.protocol!=='https:'||p.username||p.password||p.hash||p.port&&p.port!=='443')fail('jw_source_url_rejected');return p.pathname.toLowerCase().endsWith('.m3u8');}
function extract(source){
 if(source.length>1200000)fail('jw_input_limit');
 const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'}),writes=new Map(),bindings=new Set(),setups=[],urls=new Set(),definitions=new Map(),parents=new WeakMap(),mutations=new Set(),escapes=new Set(),objects=new Map();let dynamicScope=false;
 walk(ast,n=>{for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')parents.set(c,n);}else if(v&&typeof v.type==='string')parents.set(v,n);}});
 const write=(name)=>writes.set(name,(writes.get(name)||0)+1);
 const root=n=>{let depth=0;while(n&&n.type==='MemberExpression'&&depth++<32)n=n.object;return n&&n.type==='Identifier'?n.name:null;};
 walk(ast,n=>{
  if(n.type==='VariableDeclarator'&&n.id.type!=='Identifier')fail('jw_complex_binding');
  if((/Function/.test(n.type)||n.type==='ClassDeclaration'||n.type==='ClassExpression')&&n.id)write(n.id.name);
  if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){
   write(n.id.name);if(jwCall(n.init))bindings.add(n.id.name);
   const declaration=parents.get(n),scope=declaration&&parents.get(declaration);
   if(n.init&&scope&&(scope.type==='Program'||scope.type==='BlockStatement'))definitions.set(n.id.name,{value:n.init,scope,kind:declaration.kind,node:n});
   if(n.init&&n.init.type==='Identifier')escapes.add(n.init.name);
  }
  if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'){write(n.left.name);if(n.operator==='='&&jwCall(n.right))bindings.add(n.left.name);}
  if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression'){
   mutations.add(root(n.left));const left=n.left;
   if(left.object.type==='Identifier'&&['window','globalThis','self'].includes(left.object.name)){
    if(!left.computed&&left.property.type==='Identifier')write(left.property.name);
    else if(left.property.type==='Literal'&&typeof left.property.value==='string')write(left.property.value);
    else dynamicScope=true;
   }
  }
  if(n.type==='AssignmentExpression'&&n.right.type==='Identifier')escapes.add(n.right.name);
  if(n.type==='UpdateExpression'&&n.argument.type==='Identifier')write(n.argument.name);
  if(n.type==='UpdateExpression'&&n.argument.type==='MemberExpression')mutations.add(root(n.argument));
  if(n.type==='UnaryExpression'&&n.operator==='delete'&&n.argument.type==='MemberExpression')mutations.add(root(n.argument));
  if(n.type==='CallExpression'||n.type==='NewExpression'){
   for(const arg of n.arguments)if(arg.type==='Identifier')escapes.add(arg.name);
   if(n.callee.type==='Identifier'&&['eval','Function'].includes(n.callee.name))dynamicScope=true;
  }
  if(n.type==='ReturnStatement'&&n.argument&&n.argument.type==='Identifier')escapes.add(n.argument.name);
  if(n.type==='WithStatement')dynamicScope=true;
  if(/Function/.test(n.type)&&n.params)for(const p of n.params){if(p.type==='Identifier')write(p.name);else fail('jw_complex_binding');}
  if(n.type==='CatchClause'&&n.param){if(n.param.type==='Identifier')write(n.param.name);else fail('jw_complex_binding');}
 });
 if(writes.has('jwplayer'))fail('jw_constructor_shadowed');
 const type=n=>n&&/^[A-Za-z]{1,40}$/.test(n.type)?n.type.toLowerCase():'missing';
 function memberField(n){
  if(n.object.type!=='Identifier')return 'unknown';
  const d=definitions.get(n.object.name);if(!d||d.value.type!=='ObjectExpression')return 'unknown';
  const props=d.value.properties;if(props.length>100)return 'large_object';
  if(props.some(p=>p.type!=='Property'||p.computed))return 'dynamic_object';
  let key=null;
  if(!n.computed&&n.property.type==='Identifier')key=n.property.name;
  else if(n.computed&&n.property.type==='Literal'&&['string','number'].includes(typeof n.property.value))key=String(n.property.value);
  if(key===null)return 'unknown';
  const found=props.filter(p=>(p.key.type==='Identifier'?p.key.name:String(p.key.value))===key);
  if(found.length!==1)return found.length?'duplicate':'absent';
  if(found[0].kind!=='init')return 'accessor';if(found[0].method)return 'method';return type(found[0].value);
 }
 function leftShape(n,depth=0){
  let shape=type(n);if(depth>=2)return shape;
  if(n&&n.type==='Identifier'){
   const count=writes.get(n.name)||0,d=definitions.get(n.name);
   shape+='_writes_'+(count===0?'none':count===1?'one':'many')+'_init_'+(d?type(d.value):'unavailable');
   if(d)shape+='_order_'+(d.value.end<n.start?'before':'after')+'_scope_'+(d.scope.start<=n.start&&d.scope.end>=n.end?'visible':'outside')+'_kind_'+(['var','let','const'].includes(d.kind)?d.kind:'unknown');
  }else if(n&&n.type==='MemberExpression'){
   shape+='_object_'+leftShape(n.object,depth+1)+'_key_'+(!n.computed?'named':type(n.property))+'_field_'+memberField(n);
  }else if(n&&n.type==='CallExpression')shape+='_callee_'+type(n.callee);
  return shape;
 }
 function logicalFailure(n,error){
  const cause=error&&typeof error.message==='string'&&/^jw_[a-z_]{1,1024}$/.test(error.message)?error.message.slice(3):'nested_or_limit';
  return 'jw_logical_'+({'||':'or','&&':'and','??':'nullish'}[n.operator]||'unknown')+'_left_'+leftShape(n.left)+'_cause_'+cause;
 }
 const forbidden=new Set(['__proto__','prototype','constructor']);
 function keyOf(n){
  let key;
  if(!n.computed&&n.property.type==='Identifier')key=n.property.name;
  else if(n.computed&&n.property.type==='Literal'&&['string','number'].includes(typeof n.property.value))key=String(n.property.value);
  else fail('jw_member_key_not_literal');
  if(forbidden.has(key))fail('jw_member_forbidden_key');return key;
 }
 function literalPrimitive(n){return n&&n.type==='Literal'&&(n.value===null||['string','boolean'].includes(typeof n.value)||typeof n.value==='number'&&Number.isFinite(n.value));}
 function ownMember(n,depth,seen){
  if(n.optional||n.object.type!=='Identifier')fail('jw_member_object_not_simple');
  const name=n.object.name,d=definitions.get(name);
  if(dynamicScope||!d||writes.get(name)!==1||d.value.type!=='ObjectExpression'||d.value.end>=n.start||d.scope.start>n.start||d.scope.end<n.end)fail('jw_member_definition_unresolved');
  if(mutations.has(name)||escapes.has(name))fail('jw_member_mutation_or_escape');
  if(!objects.has(name)){
   const props=d.value.properties;if(props.length>100)fail('jw_member_object_limit');const data=new Map();
   for(const p of props){
    if(p.type!=='Property'||p.computed||p.method||p.kind!=='init'||!literalPrimitive(p.value))fail('jw_member_object_not_plain');
    const key=p.key.type==='Identifier'?p.key.name:p.key.type==='Literal'&&['string','number'].includes(typeof p.key.value)?String(p.key.value):null;
    if(key===null||forbidden.has(key)||data.has(key))fail('jw_member_object_key_rejected');data.set(key,p.value);
   }
   walk(ast,ref=>{
    if(ref.type!=='Identifier'||ref.name!==name)return;const parent=parents.get(ref);
    if(parent===d.node&&parent.id===ref)return;
    if(parent&&parent.type==='Property'&&parent.key===ref&&!parent.computed&&!parent.shorthand)return;
    if(parent&&parent.type==='MemberExpression'&&parent.property===ref&&!parent.computed)return;
    if(parent&&parent.type==='MemberExpression'&&parent.object===ref&&!parent.optional){
     keyOf(parent);const use=parents.get(parent);
     if(use&&((use.type==='CallExpression'||use.type==='NewExpression')&&use.callee===parent||use.type==='TaggedTemplateExpression'&&use.tag===parent))fail('jw_member_method_use');return;
    }
    fail('jw_member_unproved_use');
   });objects.set(name,data);
  }
  const key=keyOf(n),data=objects.get(name);if(!data.has(key))fail('jw_member_own_field_missing');return primitive(data.get(key),depth+1,seen);
 }
 let resolutionSteps=0;
 function primitive(n,depth=0,seen=new Set()){
  if(!n)fail('jw_source_missing');if(depth>32||++resolutionSteps>1000)fail('jw_static_resolution_limit');
  const next=x=>primitive(x,depth+1,seen);let value;
  if(n.type==='Literal'){if(!literalPrimitive(n))fail('jw_static_nonprimitive_literal');value=n.value;}
  else if(n.type==='BinaryExpression'&&n.operator==='+'){const a=next(n.left),b=next(n.right);if(typeof a!=='string'||typeof b!=='string')fail('jw_static_concat_not_strings');value=a+b;}
  else if(n.type==='TemplateLiteral'&&n.expressions.length===0)value=n.quasis[0].value.cooked;
  else if(n.type==='LogicalExpression'){
   let left;try{left=next(n.left);}catch(error){fail(logicalFailure(n,error));}
   if(n.operator==='||')value=left?left:next(n.right);else if(n.operator==='&&')value=left?next(n.right):left;else if(n.operator==='??')value=left===null||left===undefined?next(n.right):left;else fail('jw_logical_operator_unsupported');
  }else if(n.type==='ConditionalExpression'){let test;try{test=next(n.test);}catch(_){fail('jw_conditional_test_unresolved');}value=next(test?n.consequent:n.alternate);}
  else if(n.type==='UnaryExpression'&&n.operator==='!')value=!next(n.argument);
  else if(n.type==='UnaryExpression'&&n.operator==='void'){next(n.argument);value=undefined;}
  else if(n.type==='Identifier'&&n.name==='undefined'&&!writes.has('undefined'))value=undefined;
  else if(n.type==='Identifier'){
   const d=definitions.get(n.name);if(!d||writes.get(n.name)!==1||seen.has(n.name)||d.value.end>=n.start||d.scope.start>n.start||d.scope.end<n.end)fail('jw_source_identifier_unresolved');const chain=new Set(seen);chain.add(n.name);value=primitive(d.value,depth+1,chain);
  }else if(n.type==='MemberExpression')value=ownMember(n,depth,seen);
  else fail('jw_nonliteral_source_'+n.type.toLowerCase());
  if(typeof value==='string'&&value.length>16000)fail('jw_static_string_limit');return value;
 }
 function staticString(n){const value=primitive(n);if(typeof value!=='string')fail('jw_source_result_not_string');return value;}
 walk(ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&!n.callee.computed&&n.callee.property.name==='setup'){
  const obj=n.callee.object,linked=jwCall(obj)||obj.type==='Identifier'&&bindings.has(obj.name)&&writes.get(obj.name)===1;if(linked){if(n.arguments.length!==1)fail('jw_dynamic_configuration');setups.push(n.arguments[0]);}
 }});
 if(setups.length!==1)fail('jw_setup_not_unique');
 function files(config,depth){
  if(depth>1)fail('jw_playlist_depth');const playlist=field(config,'playlist'),sources=field(config,'sources'),file=field(config,'file');if([playlist,sources,file].filter(Boolean).length!==1)fail('jw_source_configuration_ambiguous');
  if(playlist){if(playlist.type!=='ArrayExpression'||playlist.elements.length!==1)fail('jw_playlist_not_unique');files(playlist.elements[0],depth+1);}
  if(sources){if(sources.type!=='ArrayExpression'||!sources.elements.length||sources.elements.length>20)fail('jw_dynamic_sources');for(const item of sources.elements){const value=staticString(field(item,'file'));if(hls(value))urls.add(value);}}
  if(file){const value=staticString(file);if(hls(value))urls.add(value);}
 }
 files(setups[0],0);if(urls.size!==1)fail(urls.size?'jw_hls_ambiguous':'jw_hls_missing');return {status:'jw_hls_unique',url:[...urls][0],setup_count:1};
}
function decodeAndExtract(source){
 if(Buffer.byteLength(source,'utf8')>200000)fail('jw_packed_input_limit');const child=cp.spawnSync(process.execPath,['--expose-internals','--max-old-space-size=128',path.join(__dirname,'instrument_routing.cjs'),'--inspect-packed'],{input:source,encoding:'utf8',timeout:5000,maxBuffer:6000000});if(child.error||child.status!==0)fail('jw_packed_parser_failed');const data=JSON.parse(child.stdout);if(data.status!=='packed_inspection_complete'||!Array.isArray(data.candidates)||data.candidates.length!==1||data.candidates[0].status!=='decoded_candidate')fail('jw_packed_candidate_not_unique');return extract(data.candidates[0].decoded);
}
function selfTest(){
 const url='https://cdn.fixture.net/master.m3u8?token=private',u=JSON.stringify(url),setup=x=>'jwplayer("v").setup({file:('+x+')});';
 const positives=[setup(u),'var p=jwplayer("v");p.setup({file:'+u+'});','jwplayer("v").setup({sources:[{file:'+u+'}]});','jwplayer("v").setup({playlist:[{file:'+u+'}]});','const ad="https://ads.fixture.net/ad.m3u8";'+setup(u),'const x='+u+';'+setup('x'),'(()=>{const x='+u+';'+setup('x')+'})();',setup('"https://cdn.fixture.net/"+"master.m3u8?token=private"')];
 for(const x of ['""||'+u,u+'||fetch("/never")','true&&'+u,'null??'+u,'undefined??'+u,'false||'+u,'0||'+u,u+'??fetch("/never")','true?'+u+':fetch("/never")','false?fetch("/never"):'+u,'!false&&'+u])positives.push(setup(x));
 for(const [before,value] of [
 ['var obj={hls:'+u+'};','obj.hls'],['var obj={hls:"",backup:'+u+'};','obj.hls||obj.backup'],['const obj={hls:null};','obj.hls||'+u],['const obj={hls:false};','obj.hls||'+u],['const obj={hls:0};','obj.hls||'+u],['const obj={hls:'+u+'};','obj["hls"]'],['const obj={hls:'+u+'};','obj.hls||fetch("/never")'],['const obj={hls:"",other:null};','obj.hls||obj.other||'+u]
 ])positives.push(before+setup(value));
 const negatives=[
 'function jwplayer(){};'+setup(u),'function p(){};var p=jwplayer("v");p.setup({file:'+u+'});','other.setup({file:'+u+'});','var p=jwplayer("v");p=other;p.setup({file:'+u+'});','jwplayer("v").setup({sources:[{file:'+u+'},{file:"https://cdn.fixture.net/other.m3u8"}]});',setup('fetch("/private")'),'jwplayer("v").setup({file:'+u+',file:'+u+'});','jwplayer("v").setup({...config,file:'+u+'});',setup('"http://cdn.fixture.net/master.m3u8"'),setup(u)+setup(u),'jwplayer("v").setup({sources:[{src:"x"}]});','let x='+u+';x="changed";'+setup('x'),setup('x')+'const x='+u+';','{const x='+u+';}'+setup('x'),'const x=fetch("/private");'+setup('x')];
 for(const x of ['unknown||'+u,'window.x||'+u,'fetch("/private")||'+u,'false&&'+u,'false??'+u,'true&&fetch("/private")','fetch("/private")?'+u+':'+u])negatives.push(setup(x));
 for(const [before,value] of [
 ['const obj={get hls(){throw Error("never");}};','obj.hls'],['const obj={hls:'+u+'};obj.hls="changed";','obj.hls'],['const obj={hls:'+u+'};consume(obj);','obj.hls'],['const obj={hls:'+u+'};const alias=obj;','obj.hls'],['const obj={hls:'+u+'};const box={ref:obj};','obj.hls'],['const obj={hls:'+u+'};','obj.unknown'],['const obj={hls:'+u+',hls:'+u+'};','obj.hls'],['const obj={...other,hls:'+u+'};','obj.hls'],['const obj={hls:'+u+',method(){}};','obj.hls'],['const obj={hls:'+u+',nested:{}};','obj.hls'],['const obj={hls:'+u+'};','obj[fetch("/private")]'],['const obj={hls:'+u+'};const key="hls";','obj[key]'],['const obj={__proto__:{},hls:'+u+'};','obj.hls'],['const obj={hls:'+u+'};','obj.constructor'],['const obj={hls:'+u+'};function mutate(){obj.hls="changed";}','obj.hls'],['const obj={hls:'+u+'};function escape(){return obj;}','obj.hls'],['const obj={hls:'+u+'};obj.hls();','obj.hls'],['var obj={hls:'+u+'};window.obj={hls:"changed"};','obj.hls'],['var obj={hls:'+u+'};eval("ignored");','obj.hls']
 ])negatives.push(before+setup(value));
 let passed=0;for(const source of positives){if(extract(source).url!==url)fail('fixture_failed');passed++;}for(const source of negatives){let rejected=false;try{extract(source);}catch(_){rejected=true;}if(!rejected)fail('fixture_failed');passed++;}
 return {passed,total:positives.length+negatives.length,scope:'Synthetic own-literal member selection, alias/escape/mutation rejection and short-circuit regression tests. No remote code or network executed.'};
}
try{process.stdout.write(JSON.stringify(process.argv.includes('--self-test')?selfTest():decodeAndExtract(fs.readFileSync(0,'utf8'))));}catch(error){const code=/^jw_[a-z_]+$/.test(error.message)?error.message:'jw_parse_or_decode_failed';process.stdout.write(JSON.stringify({status:'unsupported',code}));process.exitCode=1;}
