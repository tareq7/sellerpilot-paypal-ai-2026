'use strict';
const el=id=>document.getElementById(id);
const output=el('output');
const record=(status,body)=>{output.textContent='HTTP '+status+'\n'+JSON.stringify(body,null,2)};
const call=async (method,path,body)=>{
  const token=el('token').value;
  if(token.length<32){record(0,{error:'Enter your local service approval token'});return null}
  try{
    const response=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();record(response.status,data);
    return response.ok?data:null;
  }catch(error){record(0,{error:'Local gateway unreachable or request failed'});return null}
};
const requestId=()=>{
  if(!globalThis.crypto?.randomUUID)throw new Error('Secure randomness not available');
  return crypto.randomUUID().replaceAll('-','');
};
el('create').addEventListener('click',async()=>{
  const data=await call('POST','/orders',{amount:el('amount').value,requestId:requestId(),approved:true});
  if(!data)return;
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
const selectedId=()=>el('orderId').value.trim().toUpperCase();
el('refresh').addEventListener('click',()=>call('GET','/orders/'+encodeURIComponent(selectedId())));
el('capture').addEventListener('click',()=>call('POST','/orders/'+encodeURIComponent(selectedId())+'/capture',{requestId:requestId(),approved:true}));
el('explain').addEventListener('click',()=>call('POST','/orders/'+encodeURIComponent(selectedId())+'/explain',{}));
