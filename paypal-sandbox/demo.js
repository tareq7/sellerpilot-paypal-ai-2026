import { createOperationIds } from './idempotency.mjs';
const operationIds=createOperationIds();
let sessionRevision=0;
let createAttempt=0;
const el=id=>document.getElementById(id);
const output=el('output');
const record=(status,body)=>{output.textContent='HTTP '+status+'\n'+JSON.stringify(body,null,2)};
const call=async (method,path,body,isCurrent=()=>true)=>{
  const token=el('token').value;
  if(token.length<32){record(0,{error:'Enter your local service approval token'});return null}
  try{
    const response=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if (!isCurrent()) return null;
    record(response.status,data);
    return response.ok?data:null;
  }catch(error){if(isCurrent())record(0,{error:'Local gateway unreachable or request failed'});return null}
};
el('create').addEventListener('click',async()=>{
  const amount=el('amount').value.trim();
  if(!/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/.test(amount)||Number(amount)<0.01||Number(amount)>10){
    record(0,{error:'Enter a sandbox amount from 0.01 to 10.00 USD, with two decimal places'});return;
  }
  let requestId;
  try{requestId=operationIds.get('create',amount)}
  catch{record(0,{error:'Could not create a valid request identifier'});return}
  const session=sessionRevision;
  const attempt=++createAttempt;
  const data=await call('POST','/orders',{amount,requestId,approved:true},()=>sessionRevision===session&&createAttempt===attempt);
  if(sessionRevision!==session||createAttempt!==attempt||!data)return;
  el('orderId').value=data.id||'';
  const link=(data.links||[]).find(x=>x.rel==='approve'||x.rel==='payer-action');
  const holder=el('approvalLink');holder.replaceChildren();
  if(link&&typeof link.href==='string'){
    const u=new URL(link.href);
    if(u.protocol==='https:'&&(u.hostname==='www.sandbox.paypal.com'||u.hostname==='sandbox.paypal.com')){
      const a=document.createElement('a');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';a.className='action';
      a.textContent='Approve in PayPal sandbox';holder.appendChild(a);
    }
  }
});
const selectedId=()=>{
  const id=el('orderId').value.trim().toUpperCase();
  if(!/^[A-Z0-9]{8,32}$/.test(id)){record(0,{error:'Enter a valid PayPal sandbox order ID first'});return null}
  return id;
};
const currentSession=()=>{const revision=sessionRevision;return ()=>revision===sessionRevision};
el('refresh').addEventListener('click',()=>{
  const id=selectedId();if(!id)return;
  return call('GET','/orders/'+encodeURIComponent(id),undefined,currentSession());
});
el('capture').addEventListener('click',()=>{
  const id=selectedId();if(!id)return;
  let requestId;
  try{requestId=operationIds.get('capture',id)}
  catch{record(0,{error:'Could not create a valid capture request identifier'});return}
  return call('POST','/orders/'+encodeURIComponent(id)+'/capture',{requestId,approved:true},currentSession());
});
el('explain').addEventListener('click',()=>{
  const id=selectedId();if(!id)return;
  return call('POST','/orders/'+encodeURIComponent(id)+'/explain',{},currentSession());
});

// Reset is the only way to start a fresh logical order with a new idempotency key.
el('newOrder').addEventListener('click',()=>{
  sessionRevision++;
  createAttempt++;
  operationIds.reset();
  el('orderId').value='';
  el('approvalLink').replaceChildren();
  record(0,{message:'New synthetic order session. Approval will be required again.'});
});
