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
   if(n.init&&scope&&(scope.type==='Program'||scope.type==='BlockStatement'))definitions.set(n.id.name,{value:n.init,scope});
  }
  if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'){write(n.left.name);if(n.operator==='='&&jwCall(n.right))bindings.add(n.left.name);}
  if(n.type==='UpdateExpression'&&n.argument.type==='Identifier')write(n.argument.name);
  if(/Function/.test(n.type)&&n.params)for(const p of n.params){if(p.type==='Identifier')write(p.name);else fail('jw_complex_binding');}
  if(n.type==='CatchClause'&&n.param){if(n.param.type==='Identifier')write(n.param.name);else fail('jw_complex_binding');}
 });
 if(writes.has('jwplayer'))fail('jw_constructor_shadowed');
 let resolutionSteps=0;
 function staticString(n,depth=0,seen=new Set()){
  if(!n)fail('jw_source_missing');
  if(depth>32||++resolutionSteps>1000)fail('jw_static_resolution_limit');
  let value;
  if(n.type==='Literal'){if(typeof n.value!=='string')fail('jw_source_literal_not_string');value=n.value;}
  else if(n.type==='BinaryExpression'&&n.operator==='+')value=staticString(n.left,depth+1,seen)+staticString(n.right,depth+1,seen);
  else if(n.type==='TemplateLiteral'&&n.expressions.length===0)value=n.quasis[0].value.cooked;
  else if(n.type==='Identifier'){
   const d=definitions.get(n.name);
   if(!d||writes.get(n.name)!==1||seen.has(n.name)||d.value.end>=n.start||d.scope.start>n.start||d.scope.end<n.end)fail('jw_source_identifier_unresolved');
   const next=new Set(seen);next.add(n.name);value=staticString(d.value,depth+1,next);
  }else fail('jw_nonliteral_source_'+n.type.toLowerCase());
  if(typeof value!=='string'||value.length>16000)fail('jw_static_string_limit');return value;
 }
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
 return {passed,total:24,scope:'Synthetic JW selection, bounded static strings and AST failure classification only. No remote code evaluated or network requested.'};}
try{process.stdout.write(JSON.stringify(process.argv.includes('--self-test')?selfTest():decodeAndExtract(fs.readFileSync(0,'utf8'))));}catch(error){const code=/^jw_[a-z_]+$/.test(error.message)?error.message:'jw_parse_or_decode_failed';process.stdout.write(JSON.stringify({status:'unsupported',code}));process.exitCode=1;}
