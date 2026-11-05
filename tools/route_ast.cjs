/* Structural AST inspection only: no evaluation of source expressions. */
'use strict';
const crypto = require('node:crypto');
function walk(root, visit) {
  const stack=[root],seen=new WeakSet();let count=0;
  while(stack.length){const n=stack.pop();if(!n||typeof n!=='object'||seen.has(n))continue;seen.add(n);if(++count>200000)throw Error('ast_limit');if(typeof n.type==='string')visit(n);for(const [key,value]of Object.entries(n)){if(['raw','start','end','loc','range'].includes(key))continue;if(Array.isArray(value)){for(const child of value)if(child&&typeof child==='object')stack.push(child);}else if(value&&typeof value==='object')stack.push(value);}}
}
function name(n){return n&&n.type==='Identifier'&&/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(n.name)?n.name:null;}
function target(n){if(name(n))return name(n);if(n&&n.type==='MemberExpression'){if(!n.computed)return name(n.property);if(n.property&&n.property.type==='Literal'&&['main','dmca','rules'].includes(n.property.value))return n.property.value;}return null;}
function shape(n,depth=0){
  if(!n)return{type:'absent'};const out={type:n.type};if(depth>3)return out;
  if(n.type==='Identifier')out.name=name(n);
  else if(n.type==='Literal'){
    out.kind=typeof n.value;
    if(typeof n.value==='string'){out.characters=n.value.length;out.sha256=crypto.createHash('sha256').update(n.value).digest('hex');}
    else if(typeof n.value==='number'&&Number.isFinite(n.value))out.value=n.value;
    else if(typeof n.value==='boolean'||n.value===null)out.value=n.value;
  }else if(n.type==='ArrayExpression'){out.elements=n.elements.length;out.sample=n.elements.slice(0,4).map(x=>shape(x,depth+1));}
  else if(n.type==='CallExpression'){out.callee=shape(n.callee,depth+1);out.arguments=(n.arguments||[]).slice(0,6).map(x=>shape(x,depth+1));}
  else if(n.type==='MemberExpression'){out.object=shape(n.object,depth+1);out.property=shape(n.property,depth+1);out.computed=!!n.computed;}
  else if(n.type==='BinaryExpression'||n.type==='LogicalExpression'){out.operator=n.operator;out.left=shape(n.left,depth+1);out.right=shape(n.right,depth+1);}
  else if(n.type==='UnaryExpression'){out.operator=n.operator;out.argument=shape(n.argument,depth+1);}
  else if(n.type==='ConditionalExpression'){out.test=shape(n.test,depth+1);out.consequent=shape(n.consequent,depth+1);out.alternate=shape(n.alternate,depth+1);}
  return out;
}
function inspectAst(ast){
  const bindings=new Map(),routes={main:[],dmca:[],rules:[]},arrays=[];
  function bind(id,value){if(id){if(!bindings.has(id))bindings.set(id,[]);bindings.get(id).push(value);}}
  walk(ast,n=>{
    let id=null,value=null;
    if(n.type==='VariableDeclarator'){id=name(n.id);value=n.init;bind(id,value);}
    else if(n.type==='AssignmentExpression'&&n.operator==='='){id=target(n.left);value=n.right;if(name(n.left))bind(id,value);}
    else if(n.type==='FunctionDeclaration')bind(name(n.id),n);
    if(Object.hasOwn(routes,id)&&value&&routes[id].length<2)routes[id].push(value);
    if(n.type==='ArrayExpression'&&n.elements.length>=8)arrays.push({elements:n.elements.length,string_literals:n.elements.filter(x=>x&&x.type==='Literal'&&typeof x.value==='string').length});
  });
  function describe(id){
    const chain=[],seen=new Set();let current=id;
    for(let depth=0;depth<4&&current&&!seen.has(current);depth++){
      seen.add(current);const values=bindings.get(current)||[];const row={identifier:current,binding_count:values.length};chain.push(row);if(!values.length)break;
      const declaration=values.find(x=>x&&x.type==='FunctionDeclaration');
      if(values.length!==1&&!declaration){row.value_types=values.map(x=>x?x.type:'absent').slice(0,4);break;}
      const node=declaration||values[0];row.summary_only=values.length!==1;row.value_type=node?node.type:'absent';if(name(node)){current=name(node);continue;}
      if(node&&['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
        row.parameters=(node.params||[]).map(x=>name(x)||x.type).slice(0,8);const types={},calls=new Set(),methods=new Set(),returns=[];
        walk(node.body,x=>{types[x.type]=(types[x.type]||0)+1;if(x.type==='CallExpression'&&name(x.callee))calls.add(name(x.callee));if(x.type==='ReturnStatement'&&returns.length<1)returns.push(shape(x.argument));if(x.type==='MemberExpression'){const p=x.property;const key=x.computed&&p&&p.type==='Literal'?p.value:name(p);if(['charCodeAt','fromCharCode','indexOf','push','shift','split','slice','join','substring'].includes(key))methods.add(key);}});
        row.node_types=types;row.called_identifiers=[...calls].sort().slice(0,6);row.recognized_methods=[...methods].sort();row.return_shapes=returns;
      }else row.expression=shape(node);
      break;
    }
    return chain;
  }
  const output={method:'Structural AST data only. Strings are hashed, never evaluated.',routes:{},largest_arrays:arrays.sort((a,b)=>b.elements-a.elements).slice(0,4)};
  for(const id of ['main','dmca','rules']){
    const referenced=new Set();for(const expression of routes[id])walk(expression,n=>{if(n.type==='CallExpression'&&name(n.callee))referenced.add(name(n.callee));});
    output.routes[id]={matches:routes[id].length,expression_shapes:routes[id].map(x=>shape(x)),called_bindings:[...referenced].sort().slice(0,3).map(describe)};
  }
  return output;
}
function selfTest(){
  const assert=require('node:assert/strict'),id=name=>({type:'Identifier',name}),lit=value=>({type:'Literal',value});
  const call={type:'CallExpression',callee:id('_0xabc'),arguments:[lit(33),lit('private-key')]};
  const fn={type:'FunctionDeclaration',id:id('_0xabc'),params:[id('index')],body:{type:'BlockStatement',body:[{type:'ReturnStatement',argument:{type:'MemberExpression',object:id('table'),property:id('index'),computed:true}}]}};
  const ast={type:'Program',body:[fn,{type:'VariableDeclarator',id:id('main'),init:{type:'ArrayExpression',elements:[call]}},{type:'VariableDeclarator',id:id('dmca'),init:{type:'ArrayExpression',elements:[lit('https://secret.net/id?token=private')]}}]};
  const report=inspectAst(ast),text=JSON.stringify(report);let passed=0;
  assert.equal(report.routes.main.matches,1);passed++;
  assert.equal(report.routes.main.expression_shapes[0].sample[0].callee.name,'_0xabc');passed++;
  assert.equal(report.routes.main.called_bindings[0][0].value_type,'FunctionDeclaration');passed++;
  assert.ok(!text.includes('private-key')&&!text.includes('secret.net')&&!text.includes('token='));passed++;
  assert.equal(shape(lit(33)).value,33);passed++;
  assert.equal(report.routes.rules.matches,0);passed++;
  const aliases=inspectAst({type:'Program',body:[fn,{type:'VariableDeclarator',id:id('alias'),init:id('_0xabc')},{type:'VariableDeclarator',id:id('rules'),init:{type:'CallExpression',callee:id('alias'),arguments:[]}}]});
  assert.equal(aliases.routes.rules.called_bindings[0][1].identifier,'_0xabc');passed++;
  const cyclic={type:'Program',body:[]};cyclic.self=cyclic;assert.equal(inspectAst(cyclic).routes.main.matches,0);passed++;
  const rewritten=inspectAst({type:'Program',body:[...ast.body,{type:'AssignmentExpression',operator:'=',left:id('_0xabc'),right:{type:'FunctionExpression',params:[],body:{type:'BlockStatement',body:[]}}}]});
  assert.equal(rewritten.routes.main.called_bindings[0][0].value_type,'FunctionDeclaration');assert.equal(rewritten.routes.main.called_bindings[0][0].summary_only,true);passed++;
  return{passed,total:9,scope:'Synthetic AST data; no real script deobfuscation or playback tested.'};
}
module.exports={inspectAst,selfTest};
