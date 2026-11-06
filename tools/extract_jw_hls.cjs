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
 const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'}),writes=new Map(),bindings=new Set(),setups=[],urls=new Set(),definitions=new Map(),parents=new WeakMap();
 walk(ast,n=>{for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')parents.set(c,n);}else if(v&&typeof v.type==='string')parents.set(v,n);}});
 const write=(name)=>writes.set(name,(writes.get(name)||0)+1);
 walk(ast,n=>{
  if(n.type==='VariableDeclarator'&&n.id.type!=='Identifier')fail('jw_complex_binding');
  if((/Function/.test(n.type)||n.type==='ClassDeclaration'||n.type==='ClassExpression')&&n.id)write(n.id.name);
  if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){
   write(n.id.name);if(jwCall(n.init))bindings.add(n.id.name);
   const declaration=parents.get(n),scope=declaration&&parents.get(declaration);
   if(n.init&&scope&&(scope.type==='Program'||scope.type==='BlockStatement'))definitions.set(n.id.name,{value:n.init,scope,kind:declaration.kind});
  }
  if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'){write(n.left.name);if(n.operator==='='&&jwCall(n.right))bindings.add(n.left.name);}
  if(n.type==='UpdateExpression'&&n.argument.type==='Identifier')write(n.argument.name);
  if(/Function/.test(n.type)&&n.params)for(const p of n.params){if(p.type==='Identifier')write(p.name);else fail('jw_complex_binding');}
  if(n.type==='CatchClause'&&n.param){if(n.param.type==='Identifier')write(n.param.name);else fail('jw_complex_binding');}
 });
 if(writes.has('jwplayer'))fail('jw_constructor_shadowed');
 const type=n=>n&&/^[A-Za-z]{1,40}$/.test(n.type)?n.type.toLowerCase():'missing';
 function leftShape(n){
  let shape=type(n);
  if(n&&n.type==='Identifier'){
   const count=writes.get(n.name)||0,d=definitions.get(n.name);
   shape+='_writes_'+(count===0?'none':count===1?'one':'many')+'_init_'+(d?type(d.value):'unavailable');
   if(d)shape+='_order_'+(d.value.end<n.start?'before':'after')+'_scope_'+(d.scope.start<=n.start&&d.scope.end>=n.end?'visible':'outside')+'_kind_'+(['var','let','const'].includes(d.kind)?d.kind:'unknown');
  }else if(n&&n.type==='MemberExpression'){
   const known=n.object.type==='Identifier'&&['window','globalThis','document','location','navigator','localStorage','sessionStorage'].includes(n.object.name);
   shape+='_object_'+(known?'known_global_name':type(n.object));
  }else if(n&&n.type==='CallExpression')shape+='_callee_'+type(n.callee);
  return shape;
 }
 function logicalFailure(n,error){
  const cause=error&&typeof error.message==='string'&&/^jw_[a-z_]{1,100}$/.test(error.message)?error.message.slice(3):'nested_or_limit';
  return 'jw_logical_'+({'||':'or','&&':'and','??':'nullish'}[n.operator]||'unknown')+'_left_'+leftShape(n.left)+'_cause_'+cause;
 }
 let resolutionSteps=0;
 function primitive(n,depth=0,seen=new Set()){
  if(!n)fail('jw_source_missing');
  if(depth>32||++resolutionSteps>1000)fail('jw_static_resolution_limit');
  const next=x=>primitive(x,depth+1,seen);let value;
  if(n.type==='Literal'){
   if(n.value!==null&&!['string','boolean','number'].includes(typeof n.value)||typeof n.value==='number'&&!Number.isFinite(n.value))fail('jw_static_nonprimitive_literal');
   value=n.value;
  }else if(n.type==='BinaryExpression'&&n.operator==='+'){
   const a=next(n.left),b=next(n.right);if(typeof a!=='string'||typeof b!=='string')fail('jw_static_concat_not_strings');value=a+b;
  }else if(n.type==='TemplateLiteral'&&n.expressions.length===0)value=n.quasis[0].value.cooked;
  else if(n.type==='LogicalExpression'){
   let left;try{left=next(n.left);}catch(error){fail(logicalFailure(n,error));}
   if(n.operator==='||')value=left?left:next(n.right);
   else if(n.operator==='&&')value=left?next(n.right):left;
   else if(n.operator==='??')value=left===null||left===undefined?next(n.right):left;
   else fail('jw_logical_operator_unsupported');
  }else if(n.type==='ConditionalExpression'){
   let test;try{test=next(n.test);}catch(_){fail('jw_conditional_test_unresolved');}value=next(test?n.consequent:n.alternate);
  }else if(n.type==='UnaryExpression'&&n.operator==='!')value=!next(n.argument);
  else if(n.type==='UnaryExpression'&&n.operator==='void'){next(n.argument);value=undefined;}
  else if(n.type==='Identifier'&&n.name==='undefined'&&!writes.has('undefined'))value=undefined;
  else if(n.type==='Identifier'){
   const d=definitions.get(n.name);
   if(!d||writes.get(n.name)!==1||seen.has(n.name)||d.value.end>=n.start||d.scope.start>n.start||d.scope.end<n.end)fail('jw_source_identifier_unresolved');
   const chain=new Set(seen);chain.add(n.name);value=primitive(d.value,depth+1,chain);
  }else fail('jw_nonliteral_source_'+n.type.toLowerCase());
  if(typeof value==='string'&&value.length>16000)fail('jw_static_string_limit');return value;
 }
 function staticString(n){const value=primitive(n);if(typeof value!=='string')fail('jw_source_result_not_string');return value;}
 walk(ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&!n.callee.computed&&n.callee.property.name==='setup'){
  const obj=n.callee.object,linked=jwCall(obj)||obj.type==='Identifier'&&bindings.has(obj.name)&&writes.get(obj.name)===1;
  if(linked){if(n.arguments.length!==1)fail('jw_dynamic_configuration');setups.push(n.arguments[0]);}
 }});
 if(setups.length!==1)fail('jw_setup_not_unique');
 function files(config,depth){
  if(depth>1)fail('jw_playlist_depth');
  const playlist=field(config,'playlist'),sources=field(config,'sources'),file=field(config,'file');
  if([playlist,sources,file].filter(Boolean).length!==1)fail('jw_source_configuration_ambiguous');
  if(playlist){if(playlist.type!=='ArrayExpression'||playlist.elements.length!==1)fail('jw_playlist_not_unique');files(playlist.elements[0],depth+1);}
  if(sources){if(sources.type!=='ArrayExpression'||!sources.elements.length||sources.elements.length>20)fail('jw_dynamic_sources');for(const item of sources.elements){const value=staticString(field(item,'file'));if(hls(value))urls.add(value);}}
  if(file){const value=staticString(file);if(hls(value))urls.add(value);}
 }
 files(setups[0],0);if(urls.size!==1)fail(urls.size?'jw_hls_ambiguous':'jw_hls_missing');
 return {status:'jw_hls_unique',url:[...urls][0],setup_count:1};
}
function decodeAndExtract(source){
 if(Buffer.byteLength(source,'utf8')>200000)fail('jw_packed_input_limit');
 const child=cp.spawnSync(process.execPath,['--expose-internals','--max-old-space-size=128',path.join(__dirname,'instrument_routing.cjs'),'--inspect-packed'],{input:source,encoding:'utf8',timeout:5000,maxBuffer:6000000});
 if(child.error||child.status!==0)fail('jw_packed_parser_failed');
 const data=JSON.parse(child.stdout);
 if(data.status!=='packed_inspection_complete'||!Array.isArray(data.candidates)||data.candidates.length!==1||data.candidates[0].status!=='decoded_candidate')fail('jw_packed_candidate_not_unique');
 return extract(data.candidates[0].decoded);
}
function selfTest(){let passed=0;const check=x=>{if(!x)fail('fixture_failed');passed++;};const url='https://cdn.fixture.net/master.m3u8?token=private';
 check(extract('jwplayer("v").setup({sources:[{file:'+JSON.stringify(url)+'}]});').url===url);
 check(extract('var player=jwplayer("v");player.setup({file:'+JSON.stringify(url)+'});').url===url);
 check(extract('jwplayer("v").setup({playlist:[{sources:[{file:'+JSON.stringify(url)+'}]}]});').url===url);
 check(extract('const ad="https://ads.fixture.net/ad.m3u8";jwplayer("v").setup({file:'+JSON.stringify(url)+'});').url===url);
 for(const source of [
 'function jwplayer(){};jwplayer("v").setup({file:'+JSON.stringify(url)+'});',
 'function player(){};var player=jwplayer("v");player.setup({file:'+JSON.stringify(url)+'});',
 'other.setup({file:'+JSON.stringify(url)+'});',
 'var p=jwplayer("v");p=other;p.setup({file:'+JSON.stringify(url)+'});',
 'jwplayer("v").setup({sources:[{file:'+JSON.stringify(url)+'},{file:"https://cdn.fixture.net/other.m3u8"}]});',
 'jwplayer("v").setup({file:fetch("/private")});',
 'jwplayer("v").setup({file:'+JSON.stringify(url)+',file:'+JSON.stringify(url)+'});',
 'jwplayer("v").setup({...config,file:'+JSON.stringify(url)+'});',
 'jwplayer("v").setup({file:"http://cdn.fixture.net/master.m3u8"});',
 'jwplayer("v").setup({file:'+JSON.stringify(url)+'});jwplayer("z").setup({file:'+JSON.stringify(url)+'});'
 ]){let rejected=false;try{extract(source);}catch(_){rejected=true;}check(rejected);}
 for(const source of [
 'jwplayer("v").setup({file:"https://cdn.fixture.net/"+"master.m3u8?token=private"});',
 'const u='+JSON.stringify(url)+';jwplayer("v").setup({file:u});',
 'var a="https://cdn.fixture.net/";const b=a+"master.m3u8?token=private";jwplayer("v").setup({sources:[{file:b}]});',
 '(()=>{const u='+JSON.stringify(url)+';jwplayer("v").setup({file:u});})();'
 ])check(extract(source).url===url);
 for(const [source,code] of [
 ['jwplayer("v").setup({sources:[{src:"x"}]});','jw_source_missing'],
 ['jwplayer("v").setup({file:fetch("/private")});','jw_nonliteral_source_callexpression'],
 ['const u='+JSON.stringify(url)+';u="other";jwplayer("v").setup({file:u});','jw_source_identifier_unresolved'],
 ['jwplayer("v").setup({file:u});const u='+JSON.stringify(url)+';','jw_source_identifier_unresolved'],
 ['{const u='+JSON.stringify(url)+';}jwplayer("v").setup({file:u});','jw_source_identifier_unresolved'],
 ['const u=fetch("/private");jwplayer("v").setup({file:u});','jw_nonliteral_source_callexpression']
 ]){let actual='';try{extract(source);}catch(error){actual=error.message;}check(actual===code);}
 const u=JSON.stringify(url);
 for(const expression of ['""||'+u,u+'||fetch("/never")','true&&'+u,'null??'+u,'undefined??'+u,'false||'+u,'0||'+u,u+'??fetch("/never")','true?'+u+':fetch("/never")','false?fetch("/never"):'+u,'!false&&'+u])check(extract('jwplayer("v").setup({file:('+expression+')});').url===url);
 for(const [expression,code] of [
 ['unknown||'+u,'jw_logical_or_left_identifier_writes_none_init_unavailable_cause_source_identifier_unresolved'],
 ['window.u||'+u,'jw_logical_or_left_memberexpression_object_known_global_name_cause_nonliteral_source_memberexpression'],
 ['fetch("/never")||'+u,'jw_logical_or_left_callexpression_callee_identifier_cause_nonliteral_source_callexpression'],
 ['false&&'+u,'jw_source_result_not_string'],
 ['false??'+u,'jw_source_result_not_string'],
 ['true&&fetch("/never")','jw_nonliteral_source_callexpression'],
 ['fetch("/never")?'+u+':'+u,'jw_conditional_test_unresolved']
 ]){let actual='';try{extract('jwplayer("v").setup({file:('+expression+')});');}catch(error){actual=error.message;}check(actual===code);}
 const prefix='jw_logical_or_left_identifier_writes_';
 for(const [before,after,shape,cause] of [
 ['var privateName;','','one_init_unavailable','source_identifier_unresolved'],
 ['const privateName=window.secretProperty;','','one_init_memberexpression_order_before_scope_visible_kind_const','nonliteral_source_memberexpression'],
 ['const privateName=fetch("/secret");','','one_init_callexpression_order_before_scope_visible_kind_const','nonliteral_source_callexpression'],
 ['let privateName="secret";privateName="changed";','','many_init_literal_order_before_scope_visible_kind_let','source_identifier_unresolved'],
 ['', 'const privateName="secret";','one_init_literal_order_after_scope_visible_kind_const','source_identifier_unresolved'],
 ['{const privateName="secret";}','','one_init_literal_order_before_scope_outside_kind_const','source_identifier_unresolved']
 ]){let actual='';try{extract(before+'jwplayer("v").setup({file:(privateName||'+u+')});'+after);}catch(error){actual=error.message;}check(actual===prefix+shape+'_cause_'+cause&& !/privateName|secret|https/.test(actual));}
 return {passed,total:48,scope:'Synthetic selection regression and structural diagnostics only. Error codes contain AST categories, not names or values. Acceptance and network policy unchanged.'};}
try{process.stdout.write(JSON.stringify(process.argv.includes('--self-test')?selfTest():decodeAndExtract(fs.readFileSync(0,'utf8'))));}catch(error){const code=/^jw_[a-z_]+$/.test(error.message)?error.message:'jw_parse_or_decode_failed';process.stdout.write(JSON.stringify({status:'unsupported',code}));process.exitCode=1;}
