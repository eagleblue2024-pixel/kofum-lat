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
 const packed=inspectPacked("eval(function(x,y,z,t,u,v){throw Error('never_run');}('0({1:\"2://3/4.5\"})',62,6,'jwplayer|file|https|cdn.fixture.net|master|m3u8'.split('|'),0,{}))");
 check(packed.candidates[0].status==='decoded_candidate');check(packed.candidates[0].decoded.includes('master.m3u8'));
 const rejected=inspectPacked("eval(function(p,a,c,k,e,d){}(fetch('/secret'),62,1,'x'.split('|'),0,{}))");
 check(rejected.candidates[0].status==='nonliteral_arguments');
 check(inspectPacked('const unrelated=1;').candidates.length===0);
 return {passed,total:12,parser_version:acorn.version,node_version:process.version,scope:'Own synthetic fixtures only. Remote source is parsed, never executed by Node. Packed results are dictionary-decoding candidates, not evaluated function output.'};
}

function inspectPacked(source){
 if(Buffer.byteLength(source,'utf8')>200000)throw Error('packed_input_limit');
 const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'}),stack=[ast],candidates=[];let nodes=0;
 while(stack.length){
  const node=stack.pop();if(++nodes>50000)throw Error('packed_node_limit');
  if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='eval'&&node.arguments.length===1){
   const call=node.arguments[0],fn=call&&call.callee;
   if(call.type==='CallExpression'&&fn&&fn.type==='FunctionExpression'){
    if(candidates.length>=4)throw Error('packed_candidate_limit');
    const entry={status:'unsupported_wrapper',parameter_count:fn.params.length};candidates.push(entry);
    const a=call.arguments;
    if(fn.params.length===6&&fn.params.every(p=>p.type==='Identifier')&&a.length>=4){
     const literal=n=>n&&n.type==='Literal'?n.value:undefined;
     const payload=literal(a[0]),radix=literal(a[1]),count=literal(a[2]),table=a[3];
     const split=table&&table.type==='CallExpression'&&table.arguments.length===1&&literal(table.arguments[0])==='|'&&table.callee.type==='MemberExpression'&&!table.callee.computed&&table.callee.property.name==='split';
     const dictionary=split?literal(table.callee.object):undefined;
     if(typeof payload!=='string'||typeof dictionary!=='string'||!Number.isInteger(radix)||!Number.isInteger(count)){entry.status='nonliteral_arguments';}
     else if(radix<2||radix>62||count<1||count>10000||payload.length>200000||dictionary.length>1000000){entry.status='data_limits_rejected';}
     else{
      const words=dictionary.split('|');
      if(words.length<count){entry.status='dictionary_count_mismatch';}
      else{
       const alphabet='0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';let expanded=0;
       try{
        const decoded=payload.replace(/\b[0-9A-Za-z]+\b/g,token=>{
         let value=0,valid=true;
         for(const char of token){const digit=alphabet.indexOf(char);if(digit<0||digit>=radix){valid=false;break;}value=value*radix+digit;if(value>=count){valid=false;break;}}
         const result=valid&&words[value]?words[value]:token;
         expanded+=result.length;if(expanded>1000000)throw Error('decoded_limit');return result;
        });
        Object.assign(entry,{status:'decoded_candidate',radix,word_count:count,decoded});
       }catch(_){entry.status='decoded_output_limit';}
      }
     }
    }
   }
  }
  for(const value of Object.values(node)){
   if(Array.isArray(value)){for(const child of value)if(child&&typeof child.type==='string')stack.push(child);}
   else if(value&&typeof value.type==='string')stack.push(value);
  }
 }
 return {status:'packed_inspection_complete',candidates};
}
try{
 const source=process.argv.includes('--self-test')?null:fs.readFileSync(0,'utf8');
 const result=process.argv.includes('--self-test')?selfTest():process.argv.includes('--inspect-packed')?inspectPacked(source):instrument(source);
 process.stdout.write(JSON.stringify(result));
}catch(_){process.stdout.write(JSON.stringify({status:'ast_inspection_or_instrumentation_failed'}));process.exitCode=1;}
