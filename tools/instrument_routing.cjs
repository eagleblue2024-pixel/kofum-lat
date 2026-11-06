"use strict";
const fs=require('node:fs');
const acorn=require('internal/deps/acorn/acorn/dist/acorn');
const names=new Set(['main','dmca','rules']);
function instrument(source){
 if(Buffer.byteLength(source,'utf8')>3000000||source.includes('__kofumReportRouteList'))throw Error('input_limit_or_collision');
 const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});
 const counts={main:0,dmca:0,rules:0},insertions=new Map(),stack=[ast];let nodes=0;
 const add=(position,text)=>insertions.set(position,(insertions.get(position)||'')+text);
 while(stack.length){
  const node=stack.pop();if(++nodes>200000)throw Error('node_limit');
  let name,value;
  if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init){name=node.id.name;value=node.init;}
  if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='Identifier'){name=node.left.name;value=node.right;}
  if(names.has(name)){
   if(++counts[name]>12)throw Error('assignment_limit');
   const prefix='((__kofumValue)=>{try{const a=Array.isArray(__kofumValue);const ok=a&&__kofumValue.length<=100&&__kofumValue.every(x=>typeof x==="string"&&x.length<=253&&/^(?:[a-z0-9-]+\\.)+[a-z]{2,24}$/.test(x));const p=globalThis.__kofumReportRouteList('+JSON.stringify(name)+',ok?__kofumValue.slice():[],ok?"domains":a?"not_domain_list":"not_array");if(p&&typeof p.catch==="function")p.catch(()=>{});}catch(_){}return __kofumValue;} )(';
   add(value.start,prefix);add(value.end,')');
  }
  for(const value of Object.values(node)){
   if(Array.isArray(value)){for(const child of value)if(child&&typeof child.type==='string')stack.push(child);}
   else if(value&&typeof value.type==='string')stack.push(value);
  }
 }
 let output=source;
 for(const position of [...insertions.keys()].sort((a,b)=>b-a))output=output.slice(0,position)+insertions.get(position)+output.slice(position);
 return {status:'instrumented',source:output,counts,parser_version:acorn.version,node_version:process.version};
}
function selfTest(){
 const vm=require('node:vm');let passed=0;
 const check=(value)=>{if(!value)throw Error('fixture_failed');passed++;};
 for(const source of [
  "(function(){const main=['medi'+'xiru.com'];let dmca=['hglamioz.com'];const rules=['streamwish.to'];})();",
  "'use strict';let main,dmca,rules;main=['medixiru.com'];dmca=['hglamioz.com'];rules=['streamwish.to'];",
  "let main,dmca;main=dmca=['medixiru.com'];const rules=[];"
 ]){
  const result=instrument(source),seen={};
  vm.runInNewContext(result.source,{__kofumReportRouteList:(key,value,kind)=>{if(kind==='domains')seen[key]=Array.from(value);}}, {timeout:1000});
  check(Object.keys(seen).length===3);check(result.counts.main===1&&result.counts.dmca===1&&result.counts.rules===1);
 }
 check(instrument("const unrelated=['x.net'];").counts.main===0);
 try{instrument('const main=[');throw Error('bad_fixture');}catch(error){check(error.message!=='bad_fixture');}
 return {passed,total:8,parser_version:acorn.version,node_version:process.version,scope:'Own synthetic fixtures only. Remote source is parsed, never executed by Node.'};
}
try{
 const result=process.argv.includes('--self-test')?selfTest():instrument(fs.readFileSync(0,'utf8'));
 process.stdout.write(JSON.stringify(result));
}catch(_){process.stdout.write(JSON.stringify({status:'ast_instrumentation_failed'}));process.exitCode=1;}
