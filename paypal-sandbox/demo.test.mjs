import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./demo.html',import.meta.url),'utf8');
test('browser loads the ES-module control script, not a classic script',()=>{
 assert.match(html,/<script\\s+type="module"\\s+src="\\/demo\\.js"><\\/script>/);
});

test('invalid input is visible and in-flight create responses cannot restore reset orders',async()=>{
 const oldDocument=globalThis.document, oldFetch=globalThis.fetch;
 const nodes=new Map();
 for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain']){
  nodes.set(id,{value:'',textContent:'',handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
 }
 nodes.get('token').value='01234567890123456789012345678901';
 nodes.get('amount').value=''; let fetchCount=0;
 let release;
 const hold=new Promise(resolve=>{release=resolve});
 globalThis.document={getElementById:id=>nodes.get(id),createElement:()=>({})};
 globalThis.fetch=async()=>{fetchCount++;return hold};
 try{
  await import('./demo.js?regression=1');
  await nodes.get('create').handlers.click();
  assert.match(nodes.get('output').textContent,/Enter a sandbox amount/);
  assert.equal(fetchCount,0);
  await nodes.get('capture').handlers.click();
  assert.match(nodes.get('output').textContent,/valid PayPal sandbox order ID/);
  assert.equal(fetchCount,0);
  nodes.get('amount').value='1.00';
  const inFlight=nodes.get('create').handlers.click();
  assert.equal(fetchCount,1);
  await nodes.get('newOrder').handlers.click();
  release({ok:true,status:201,json:async()=>({id:'9HX123456789',status:'CREATED',links:[]})});
  await inFlight;
  assert.equal(nodes.get('orderId').value,'');
  assert.equal(nodes.get('approvalLink').children.length,0);
  assert.match(nodes.get('output').textContent,/New synthetic order session/);
 }finally{
  globalThis.document=oldDocument;globalThis.fetch=oldFetch;
 }
});
