import { createOperationIds } from './idempotency.mjs';
const operationIds=createOperationIds();
let sessionRevision=0;
let createAttempt=0;
const el=id=>document.getElementById(id);
const output=el('output');
const record=(status,body)=>{output.textContent='HTTP '+status+'\n'+JSON.stringify(body,null,2)};
const statusText=el('statusText');
const statusDetail=el('statusDetail');
const statusPanel=el('status');
const captureConfirm=el('captureConfirm');
const setStatus=(text, kind, detail)=>{
  if(statusText) statusText.textContent=text;
  if(statusDetail) statusDetail.textContent=detail || '';
  if(statusPanel) statusPanel.className='status-panel'+(kind?' '+kind:'');
};
function verifiedCaptureClient(order, expectedOrderId, expectedAmount){
  const captures=order?.purchase_units?.flatMap(p=>p.payments?.captures||[])||[];
  const completed=captures.find(c=>c.status==='COMPLETED');
  const total=completed?.amount;
  if(order?.id!==expectedOrderId || order?.status!=='COMPLETED' || !completed?.id || total?.currency_code!=='USD' || total?.value!==expectedAmount) return null;
  return completed;
}
let lastCreatedAmount = '';
let lastCreatedOrderId = '';
export function verifiedCaptureForTest(order, expectedOrderId, expectedAmount){
  return verifiedCaptureClient(order, expectedOrderId, expectedAmount);
}
function sanitizeForDisplay(body){
  // Build a strict allowlist. Removing only known PII fields is not sufficient.
  if(!body || typeof body!=='object' || Array.isArray(body)) return {message:'Unexpected response'};
  const safeText=value=>typeof value==='string' ? value.slice(0,256) : undefined;
  const safeAmount=value=>value && typeof value==='object' ? {
    currency_code:safeText(value.currency_code), value:safeText(value.value)
  } : undefined;
  const out={};
  for(const key of ['id','status','intent','create_time','update_time','message','error']){
    if(typeof body[key]==='string') out[key]=safeText(body[key]);
  }
  if(Array.isArray(body.purchase_units)){
    out.purchase_units=body.purchase_units.slice(0,5).map(unit=>{
      const u={};
      if(typeof unit?.reference_id==='string') u.reference_id=safeText(unit.reference_id);
      if(unit?.amount) u.amount=safeAmount(unit.amount);
      if(Array.isArray(unit?.payments?.captures)){
        u.payments={captures:unit.payments.captures.slice(0,5).map(cap=>({
          id:safeText(cap?.id),status:safeText(cap?.status),
          amount:safeAmount(cap?.amount),create_time:safeText(cap?.create_time)
        }))};
      }
      return u;
    });
  }
  if(typeof body.model==='string') out.model=safeText(body.model);
  if(typeof body.explanation==='string') out.explanation=body.explanation.slice(0,8192);
  if(body.order && typeof body.order==='object' && !Array.isArray(body.order)){
    const safeOrder={};
    for(const k of ['id','status','capture_status']) if(typeof body.order[k]==='string') safeOrder[k]=safeText(body.order[k]);
    if(body.order.amount) safeOrder.amount=safeAmount(body.order.amount);
    out.order=safeOrder;
  }
  // Approval links are shown through the separate validated button, not JSON.
  return out;
}
function setBusy(busy){
  for(const id of ['create','refresh','capture','explain','newOrder']){
    const n=el(id); if(n) n.disabled=Boolean(busy || (captureOutcomeUncertain && (id==='create'||id==='newOrder')));
  }
  const cap=el('capture');
  if(cap){
    const id=(el('orderId')?.value||'').trim().toUpperCase();
    const confirmed=Boolean(captureConfirm?.checked && confirmedCaptureOrderId===id);
    const retry=Boolean(captureOutcomeUncertain && captureOutcomeUncertainOrderId===id && captureRetryAuthorizedOrderId===id);
    cap.disabled=Boolean(busy || !confirmed || (captureOutcomeUncertain && !retry));
  }
}
const busyOps=new Set();
let captureOutcomeUncertain=false;
let captureOutcomeUncertainOrderId='';
let captureRetryAuthorizedOrderId='';
let confirmedCaptureOrderId=captureConfirm?.checked ? (el('orderId')?.value||'').trim().toUpperCase() : '';
const markBusy=(op, busy)=>{
  if(busy) busyOps.add(op); else busyOps.delete(op);
  setBusy(busyOps.size>0);
};
const isBusy=(op)=>busyOps.has(op);
const call=async (method,path,body,isCurrent=()=>true)=>{
  const token=el('token')?.value || '';
  if(token.length<32){record(0,{error:'Enter your local service approval token (32+ chars)'});return null}
  try{
    const response=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>({error:'Invalid JSON response'}));
    if (!isCurrent()) return null;
    record(response.status,sanitizeForDisplay(data));
    return { ok: response.ok, status: response.status, data };
  }catch(error){if(isCurrent())record(0,{error:'Local gateway unreachable or request failed — outcome unknown, check status before retrying (same PayPal-Request-Id will be reused)'});return null}
};
// Manage captureConfirm enabling
if(captureConfirm){
  const capBtn=el('capture');
  const syncCaptureBtn=()=>{
    confirmedCaptureOrderId=captureConfirm.checked ? (el('orderId')?.value||'').trim().toUpperCase() : '';
    setBusy(busyOps.size>0);
  };
  captureConfirm.addEventListener('change', syncCaptureBtn);
  syncCaptureBtn();
}
el('orderId')?.addEventListener('input',()=>{
  confirmedCaptureOrderId='';
  if(captureConfirm) captureConfirm.checked=false;
  setBusy(busyOps.size>0);
});
el('create').addEventListener('click',async()=>{
  if(captureOutcomeUncertain){ setStatus('Resolve capture for '+captureOutcomeUncertainOrderId+' before another order','error'); return; }
  if(isBusy('create')){ setStatus('Create already in flight — duplicate click ignored', 'busy'); return; }
  const amount=el('amount').value.trim();
  if(!/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/.test(amount)||Number(amount)<0.01||Number(amount)>10){
    record(0,{error:'Enter a sandbox amount from 0.01 to 10.00 USD, with two decimal places'});
    setStatus('Invalid amount — must be 0.01 to 10.00 USD with two decimals', 'error');
    return;
  }
  let requestId;
  try{requestId=operationIds.get('create',amount)}
  catch{record(0,{error:'Could not create a valid request identifier'});setStatus('Could not create request identifier','error');return}
  const session=sessionRevision;
  const attempt=++createAttempt;
  markBusy('create', true);
  setStatus('Creating sandbox order $'+amount+' — requesting PayPal sandbox…','busy');
  const res=await call('POST','/orders',{amount,requestId,approved:true},()=>sessionRevision===session&&createAttempt===attempt);
  if(sessionRevision!==session||createAttempt!==attempt){ markBusy('create', false); return; }
  markBusy('create', false);
  if(!res || !res.data){
    if(sessionRevision===session && createAttempt===attempt) setStatus('Order creation failed — see audit console','error');
    return;
  }
  if(!res.ok){
    setStatus('Order creation failed — see audit console','error');
    return;
  }
  const data=res.data;
  lastCreatedAmount = amount;
  lastCreatedOrderId = data.id||'';
  el('orderId').value=data.id||'';
  confirmedCaptureOrderId='';
  if(captureConfirm) captureConfirm.checked=false;
  setBusy(busyOps.size>0);
  const link=(data.links||[]).find(x=>x.rel==='approve'||x.rel==='payer-action');
  const holder=el('approvalLink');holder.replaceChildren();
  let hasLink=false;
  if(link&&typeof link.href==='string'){
    try{
      const u=new URL(link.href);
      if(u.protocol==='https:'&&(u.hostname==='www.sandbox.paypal.com'||u.hostname==='sandbox.paypal.com')){
        const a=document.createElement('a');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';a.className='action';
        a.textContent='Approve in PayPal sandbox';holder.appendChild(a); hasLink=true;
      }
    }catch{}
  }
  if(data.status==='CREATED'){
    setStatus('Order CREATED — approval pending. '+(hasLink?'Open sandbox buyer link to approve.':'No approval link returned.'), 'pending', 'Order ID: '+(data.id||'unknown')+' — amount $'+amount+' — live sandbox data. Next: buyer approves, then check status.');
  } else if(data.status==='APPROVED'){
    setStatus('Order already APPROVED — ready to capture (confirm checkbox required)', 'approved');
  } else {
    setStatus('Order response: '+ (data.status||'unknown') +' — check audit console', 'pending');
  }
});
const selectedId=()=>{
  const id=el('orderId').value.trim().toUpperCase();
  if(!/^[A-Z0-9]{8,32}$/.test(id)){record(0,{error:'Enter a valid PayPal sandbox order ID first'});setStatus('Enter a valid PayPal sandbox order ID (8-32 alphanumerics)','error');return null}
  return id;
};
const currentSession=(id)=>{const revision=sessionRevision;return ()=>revision===sessionRevision && (el('orderId')?.value||'').trim().toUpperCase()===id};
el('refresh').addEventListener('click',async()=>{
  const id=selectedId();if(!id)return;
  if(captureOutcomeUncertain && id!==captureOutcomeUncertainOrderId){ setStatus('Unresolved capture for '+captureOutcomeUncertainOrderId+'; check that original order','error'); return; }
  if(isBusy('refresh')){ setStatus('Status check already in flight — duplicate ignored','busy'); return; }
  const isCur=currentSession(id);
  markBusy('refresh', true);
  setStatus('Checking order status for '+id+'…','busy');
  const res=await call('GET','/orders/'+encodeURIComponent(id),undefined,isCur);
  markBusy('refresh', false);
  if(!isCur()) return;
  if(!res || !res.data) { setStatus('Could not retrieve order — see console','error'); return; }
  const data=res.data;
  const unit=data.purchase_units?.[0];
  // Prefer amount from original create for strict verification, fallback to unit amount
  const amt= (id===lastCreatedOrderId && lastCreatedAmount) ? lastCreatedAmount : unit?.amount?.value;
  const verified=amt ? verifiedCaptureClient(data, id, amt) : null;
  if(verified){
    if(captureOutcomeUncertain && captureOutcomeUncertainOrderId===id){
      captureOutcomeUncertain=false;
      captureOutcomeUncertainOrderId='';
      captureRetryAuthorizedOrderId='';
    }
    confirmedCaptureOrderId='';
    if(captureConfirm) captureConfirm.checked=false;
    setBusy(busyOps.size>0);
    setStatus('Capture COMPLETED — verified capture '+verified.id+' $'+verified.amount.value+' '+verified.amount.currency_code, 'completed', 'Order '+id+' is COMPLETED with matching capture. No further capture needed.');
  } else if(data.status==='COMPLETED'){
    setStatus('Order COMPLETED but capture not verified — do not claim as completed without matching capture record','error', 'Response shows COMPLETED but missing/incorrect capture details.');
  } else if(data.status==='APPROVED'){
    if(captureOutcomeUncertain && captureOutcomeUncertainOrderId===id){
      captureRetryAuthorizedOrderId=id;
      setBusy(busyOps.size>0);
      setStatus('APPROVED after uncertain capture: deliberate retry allowed','approved','Confirm this order again; the original PayPal-Request-Id is retained. No automatic retry or reset.');
    }else setStatus('Order APPROVED — ready to capture (check confirm box)', 'approved', 'Buyer has approved. You may now confirm and capture.');
  } else if(data.status==='CREATED'){
    setStatus('Order CREATED — approval pending (buyer must approve in sandbox.paypal.com)','pending');
  } else if(data.status){
    setStatus('Order status: '+data.status+' — see console','pending');
  } else {
    setStatus('Order status retrieved — see audit console','pending');
  }
});
el('capture').addEventListener('click',async()=>{
  const id=selectedId();if(!id)return;
  if(captureConfirm && (!captureConfirm.checked || confirmedCaptureOrderId!==id)){ record(0,{error:'Confirm capture checkbox required — check the box to confirm capturing this APPROVED sandbox order'}); setStatus('Capture confirmation required — check the confirmation box','error'); return; }
  if(isBusy('capture')){ setStatus('Capture already in flight — duplicate click ignored','busy'); return; }
  if(captureOutcomeUncertain && !(captureOutcomeUncertainOrderId===id && captureRetryAuthorizedOrderId===id)){ setStatus('Capture uncertain; check original order for an explicit same-key retry','error'); return; }
  markBusy('capture', true);
  setStatus('Verifying order '+id+' is APPROVED before capture…','busy');
  let requestId;
  try{requestId=operationIds.get('capture',id)}
  catch{record(0,{error:'Could not create a valid capture request identifier'}); setStatus('Could not create capture identifier','error'); markBusy('capture', false); return}
  // Fresh GET check before capture
  const isCur=currentSession(id);
  const pre=await call('GET','/orders/'+encodeURIComponent(id),undefined,isCur);
  if(!isCur()){ markBusy('capture', false); return; }
  if(!pre || !pre.data){
    // network failure on GET — do not blindly capture
    markBusy('capture', false);
    setStatus('Could not verify approval — capture not attempted. Check connectivity and try again (same idempotency key preserved).','error');
    return;
  }
  const order=pre.data;
  if(order.status!=='APPROVED'){
    record(pre.status, sanitizeForDisplay(order));
    if(order.status==='COMPLETED'){
      const unit=order.purchase_units?.[0];
      const amtFromUnit=unit?.amount?.value;
      const amtExpected = (id===lastCreatedOrderId && lastCreatedAmount) ? lastCreatedAmount : amtFromUnit;
      const verified=amtExpected ? verifiedCaptureClient(order, id, amtExpected) : null;
      if(verified){
        if(captureOutcomeUncertain && captureOutcomeUncertainOrderId===id){
          captureOutcomeUncertain=false;
          captureOutcomeUncertainOrderId='';
          captureRetryAuthorizedOrderId='';
        }
        confirmedCaptureOrderId='';
        if(captureConfirm) captureConfirm.checked=false;
        setBusy(busyOps.size>0);
        setStatus('Already CAPTURED — verified capture '+verified.id+' $'+verified.amount.value+' (no retry needed)','completed');
      } else {
        setStatus('Order already COMPLETED but capture not verified — see console','error');
      }
    } else {
      setStatus('Buyer has not approved order — capture not attempted (status: '+(order.status||'unknown')+')','error');
    }
    markBusy('capture', false);
    return;
  }
  setStatus('Order APPROVED verified — capturing…','busy');
  captureOutcomeUncertain=true;
  captureOutcomeUncertainOrderId=id;
  captureRetryAuthorizedOrderId='';
  // Every retry requires a fresh explicit confirmation for this same order.
  confirmedCaptureOrderId='';
  if(captureConfirm) captureConfirm.checked=false;
  const capRes=await call('POST','/orders/'+encodeURIComponent(id)+'/capture',{requestId,approved:true},isCur);
  if(!isCur()){ markBusy('capture', false); return; }
  markBusy('capture', false);
  if(!capRes || !capRes.data){
    setStatus('Capture response unavailable — outcome uncertain. Check status before any retry.','error');
    return;
  }
  if(!capRes.ok){
    // These gateway statuses are rejected locally before a PayPal capture POST.
    // Upstream PayPal failures are mapped to 502 and stay uncertain.
    if([400,401,403,409].includes(capRes.status)){
      captureOutcomeUncertain=false;
      captureOutcomeUncertainOrderId='';
      captureRetryAuthorizedOrderId='';
      confirmedCaptureOrderId='';
      if(captureConfirm) captureConfirm.checked=false;
      setBusy(busyOps.size>0);
      setStatus('Capture was rejected before payment (HTTP '+capRes.status+'). Check status before trying again.','error');
    } else {
      setStatus('Capture failed — outcome uncertain. Check status before any retry.','error');
    }
    return;
  }
  const captured=capRes.data;
  // Verify capture success only when COMPLETED with matching ID/amount/currency
  // Prefer amount from original create (user intent) for strict verification
  // Expected amount comes from a fresh GET *before* the capture POST.
  // A response cannot validate itself against its own amount.
  const expectedAmount=(id===lastCreatedOrderId && lastCreatedAmount)
    ? lastCreatedAmount : order.purchase_units?.[0]?.amount?.value;
  const verified=expectedAmount ? verifiedCaptureClient(captured,id,expectedAmount) : null;
  if(verified){
    if(captureOutcomeUncertain && captureOutcomeUncertainOrderId===id){
      captureOutcomeUncertain=false;
      captureOutcomeUncertainOrderId='';
      captureRetryAuthorizedOrderId='';
    }
    confirmedCaptureOrderId='';
    if(captureConfirm) captureConfirm.checked=false;
    setBusy(busyOps.size>0);
    setStatus('Capture COMPLETED — verified capture '+verified.id+' $'+verified.amount.value+' '+verified.amount.currency_code+' for order '+id,'completed','Live sandbox data: capture ID '+verified.id+' status COMPLETED, order ID and amount verified.');
  } else if(captured.status==='COMPLETED'){
    setStatus('Capture response is COMPLETED but not verified (amount/ID mismatch) — not claimed as completed','error');
  } else {
    setStatus('Capture not completed — status: '+(captured.status||'unknown')+' — not claimed as verified','error');
  }
});
el('explain').addEventListener('click',async()=>{
  const id=selectedId();if(!id)return;
  if(isBusy('explain')){ setStatus('Explain already in flight — duplicate ignored','busy'); return; }
  markBusy('explain', true);
  setStatus('Requesting AI explanation for '+id+'…','busy');
  const isCur=currentSession(id);
  const res=await call('POST','/orders/'+encodeURIComponent(id)+'/explain',{},isCur);
  markBusy('explain', false);
  if(!isCur()) return;
  if(!res || !res.data){ setStatus('AI explanation unavailable — see console (model not configured returns 503)','error'); return; }
  if(res.ok && res.data.explanation){
    setStatus('AI explanation received from '+ (res.data.model||'model') +': '+ String(res.data.explanation).slice(0,120),'pending','Up to 8192 explanation characters in audit console. Model output only uses sanitized order fields — not a capture confirmation.');
  } else {
    setStatus('AI explanation not available — '+ (res.data.error||'see console'), 'error');
  }
});

// Reset is the only way to start a fresh logical order with a new idempotency key.
el('newOrder').addEventListener('click',()=>{
  if(isBusy('capture') || captureOutcomeUncertain){
    record(0,{message:'Cannot reset during an in-flight or uncertain capture. Check the order status before another order.'});
    setStatus('Cannot reset: capture may still be processing. Check order status first.','error');
    return;
  }
  // A pending create may still be reset; capture state is protected above.
  sessionRevision++;
  createAttempt++;
  operationIds.reset();
  captureOutcomeUncertain=false;
  captureOutcomeUncertainOrderId='';
  captureRetryAuthorizedOrderId='';
  confirmedCaptureOrderId='';
  lastCreatedAmount='';
  lastCreatedOrderId='';
  el('orderId').value='';
  if(captureConfirm) captureConfirm.checked=false;
  const capBtn=el('capture');
  if(capBtn && captureConfirm) capBtn.disabled=true;
  el('approvalLink').replaceChildren();
  record(0,{message:'New synthetic order session. Approval will be required again. Idempotency keys reset.'});
  setStatus('New synthetic order session — approval will be required again.','pending','Previous idempotency keys cleared. Create a new order to continue. Mock data from tests is not live payment.');
});
