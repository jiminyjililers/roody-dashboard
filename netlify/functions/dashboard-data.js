'use strict';

const XERO_CLIENT_ID     = 'B174F48CA0214F40B3571221B4F516A5';
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REFRESH_TOKEN = process.env.XERO_REFRESH_TOKEN || '';
const XERO_TENANT_ID     = process.env.XERO_TENANT_ID;
const HS_API_KEY         = process.env.HUBSPOT_API_KEY;
const API_KEY            = process.env.DASHBOARD_API_KEY || 'roody-kpi-agent-2026';

const headers = {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-api-key'};

function irishDateStr(d){return d.toLocaleDateString('en-CA',{timeZone:'Europe/Dublin'});}
function addDays(s,n){const d=new Date(s+'T12:00:00');d.setDate(d.getDate()+n);return irishDateStr(d);}
function lastBizDayOf(s){const d=new Date(s+'T12:00:00');d.setDate(d.getDate()-1);while(d.getDay()===0||d.getDay()===6)d.setDate(d.getDate()-1);return irishDateStr(d);}
function weekStartOf(s){const d=new Date(s+'T12:00:00');const day=d.getDay();d.setDate(d.getDate()+(day===0?-6:1-day));return irishDateStr(d);}
function monthStartOf(s){return s.slice(0,8)+'01';}
function xd(s){return 'DateTime('+s.replace(/-/g,',')+')'; }
function parseXeroDate(v){if(!v)return '';const m=v.match(/\/Date\((-?\d+)[+-]\d+\)\//);return m?irishDateStr(new Date(parseInt(m[1]))):''; }
function invDateStr(inv){if(inv.DateString)return inv.DateString.slice(0,10);return parseXeroDate(inv.Date);}

async function xeroRefreshToken(){
  const res=await fetch('https://identity.xero.com/connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:XERO_REFRESH_TOKEN,client_id:XERO_CLIENT_ID,client_secret:XERO_CLIENT_SECRET})});
  const data=await res.json();
  if(!data.access_token)throw new Error('Xero token refresh failed: '+JSON.stringify(data));
  return{token:data.access_token,newRefreshToken:data.refresh_token};
}

async function xeroGet(path,token){
  const res=await fetch('https://api.xero.com/api.xro/2.0/'+path,{headers:{Authorization:'Bearer '+token,'Xero-tenant-id':XERO_TENANT_ID,Accept:'application/json'}});
  if(!res.ok)throw new Error('Xero API error '+res.status+' on '+path);
  return res.json();
}

async function fetchInvoicesByDateRange(from,to,token){
  const where='Type=="ACCREC" AND Status!="DELETED" AND Status!="VOIDED" AND Date>='+xd(from)+' AND Date<='+xd(to);
  const data=await xeroGet('Invoices?where='+encodeURIComponent(where)+'&summaryOnly=false',token);
  return data.Invoices||[];
}

async function fetchPaidInvoices(from,to,token){
  const data=await xeroGet('Invoices?ModifiedAfter='+addDays(from,-1)+'&Statuses=PAID&summaryOnly=false',token);
  return(data.Invoices||[]).filter(inv=>{
    if(!inv.FullyPaidOnDate)return false;
    const m=(inv.FullyPaidOnDate||'').match(/\/Date\((-?\d+)[+-]\d+\)\//);
    if(!m)return false;
    const pd=irishDateStr(new Date(parseInt(m[1])));
    inv._paidDate=pd;
    return pd>=from&&pd<=to;
  });
}

async function hubspotSearchDeals(filters,properties,limit=100){
  const all=[];let after=undefined;
  while(true){
    const body={filterGroups:[{filters}],properties,limit:Math.min(limit,100),...(after?{after}:{})};
    const res=await fetch('https://api.hubapi.com/crm/v3/objects/deals/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+HS_API_KEY},body:JSON.stringify(body)});
    const data=await res.json();
    if(data.results)all.push(...data.results);
    if(!data.paging?.next?.after||all.length>=limit)break;
    after=data.paging.next.after;
  }
  return all.slice(0,limit);
}

async function hubspotGetPipeline(){
  const res=await fetch('https://api.hubapi.com/crm/v3/pipelines/deals',{headers:{Authorization:'Bearer '+HS_API_KEY}});
  return(await res.json()).results||[];
}

async function handleRange(event,from,to){
  const key=event.headers?.['x-api-key']||event.queryStringParameters?.api_key;
  if(key!==API_KEY)return{statusCode:401,headers,body:JSON.stringify({error:'Unauthorized'})};
  try{
    const{token}=await xeroRefreshToken();
    const[invoicedList,paidList]=await Promise.all([fetchInvoicesByDateRange(from,to,token),fetchPaidInvoices(from,to,token)]);
    const ti=invoicedList.reduce((s,i)=>s+(i.Total||0),0);
    const tp=paidList.reduce((s,i)=>s+(i.Total||0),0);
    const au=await xeroGet('Invoices?Statuses=AUTHORISED&summaryOnly=false&page=1',token);
    const unpaid=au.Invoices||[];
    const ut=unpaid.reduce((s,i)=>s+(i.AmountDue||i.Total||0),0);
    const ol=unpaid.filter(i=>{const d=i.DueDateString?.slice(0,10)||parseXeroDate(i.DueDate);return d&&d<to;});
    const ot=ol.reduce((s,i)=>s+(i.AmountDue||i.Total||0),0);
    return{statusCode:200,headers,body:JSON.stringify({from,to,currency:invoicedList[0]?.CurrencyCode||'EUR',invoiced:{total:ti,count:invoicedList.length,invoices:invoicedList.map(i=>({number:i.InvoiceNumber,contact:i.Contact?.Name||'',amount:i.Total,date:invDateStr(i)}))},paid:{total:tp,count:paidList.length,invoices:paidList.map(i=>({number:i.InvoiceNumber,contact:i.Contact?.Name||'',amount:i.Total,paid_date:i._paidDate}))},outstanding:{total:ut,count:unpaid.length,overdue_total:ot,overdue_count:ol.length}})};
  }catch(err){return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
}

exports.handler=async(event)=>{
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers,body:''};
  const key=event.headers?.['x-api-key']||event.queryStringParameters?.api_key;
  if(key!==API_KEY)return{statusCode:401,headers,body:JSON.stringify({error:'Unauthorized'})};
  try{
    const rf=event.queryStringParameters?.from,rt=event.queryStringParameters?.to;
    if(rf&&rt)return handleRange(event,rf,rt);
    const qd=event.queryStringParameters?.date||irishDateStr(new Date());
    const lb=lastBizDayOf(qd),ws=weekStartOf(qd),ms=monthStartOf(qd);
    const{token,newRefreshToken}=await xeroRefreshToken();
    const[itl,ilbl,iwl,iml,ptl,pml]=await Promise.all([fetchInvoicesByDateRange(qd,qd,token),fetchInvoicesByDateRange(lb,lb,token),fetchInvoicesByDateRange(ws,qd,token),fetchInvoicesByDateRange(ms,qd,token),fetchPaidInvoices(qd,qd,token),fetchPaidInvoices(ms,qd,token)]);
    const sum=l=>l.reduce((s,i)=>s+(i.Total||0),0);
    const plbl=await fetchPaidInvoices(lb,lb,token),pwl=await fetchPaidInvoices(ws,qd,token);
    const ri=[...pml].sort((a,b)=>(b._paidDate||'').localeCompare(a._paidDate||'')).slice(0,10).map(i=>({invoiceNumber:i.InvoiceNumber,contact:i.Contact?.Name||'',amount:i.Total,currency:i.CurrencyCode||'EUR',paidDate:i._paidDate}));
    const ts=new Date(qd+'T00:00:00').getTime().toString(),te=new Date(qd+'T23:59:59').getTime().toString(),wss=new Date(ws+'T00:00:00').getTime().toString(),mss=new Date(ms+'T00:00:00').getTime().toString();
    const dp=['dealname','amount','dealstage','createdate','closedate','hs_object_id'];
    const[dct,dcw,dcm,cwm,od]=await Promise.all([hubspotSearchDeals([{propertyName:'createdate',operator:'GTE',value:ts},{propertyName:'createdate',operator:'LTE',value:te}],dp),hubspotSearchDeals([{propertyName:'createdate',operator:'GTE',value:wss},{propertyName:'createdate',operator:'LTE',value:te}],dp),hubspotSearchDeals([{propertyName:'createdate',operator:'GTE',value:mss},{propertyName:'createdate',operator:'LTE',value:te}],dp),hubspotSearchDeals([{propertyName:'dealstage',operator:'EQ',value:'closedwon'},{propertyName:'closedate',operator:'GTE',value:mss},{propertyName:'closedate',operator:'LTE',value:te}],dp),hubspotSearchDeals([{propertyName:'dealstage',operator:'NEQ',value:'closedwon'},{propertyName:'dealstage',operator:'NEQ',value:'closedlost'}],dp,200)]);
    const sd=d=>d.reduce((s,x)=>s+parseFloat(x.properties?.amount||0),0);
    const pl=await hubspotGetPipeline();const sm={};pl.forEach(p=>(p.stages||[]).forEach(s=>{sm[s.id]=s.label;}));
    const sb={};const ck=['closed','lost','dnc','do not call','not interested','no intent','outbound closed'];
    od.forEach(d=>{const st=sm[d.properties?.dealstage]||d.properties?.dealstage||'Unknown';if(ck.some(k=>st.toLowerCase().includes(k)))return;if(!sb[st])sb[st]={count:0,value:0};sb[st].count++;sb[st].value+=parseFloat(d.properties?.amount||0);});
    const rd=[...dcm].sort((a,b)=>parseInt(b.properties.createdate)-parseInt(a.properties.createdate)).slice(0,10).map(d=>({id:d.id,name:d.properties.dealname,amount:parseFloat(d.properties.amount||0),stage:sm[d.properties.dealstage]||d.properties.dealstage,created:irishDateStr(new Date(parseInt(d.properties.createdate))),url:'https://app.hubspot.com/contacts/4318501/record/0-3/'+d.id}));
    if(newRefreshToken&&newRefreshToken!==XERO_REFRESH_TOKEN){try{await fetch('https://api.netlify.com/api/v1/sites/9c126cc0-6125-4d95-a871-ef8157823131/env/XERO_REFRESH_TOKEN',{method:'PATCH',headers:{'Authorization':'Bearer '+process.env.NETLIFY_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({values:[{context:'production',value:newRefreshToken}]})});}catch(e){console.warn('Token rotation failed:',e.message);}}
    return{statusCode:200,headers,body:JSON.stringify({queryDate:qd,lastBusinessDay:lb,xero:{invoicedToday:sum(itl),invoicedLastBizDay:sum(ilbl),invoicedThisWeek:sum(iwl),invoicedThisMonth:sum(iml),paidToday:sum(ptl),paidLastBizDay:sum(plbl),paidThisWeek:sum(pwl),paidThisMonth:sum(pml),recentInvoices:ri},hubspot:{pipeline:{totalValue:sd(od),totalCount:od.length,byStage:sb},dealsCreated:{today:{count:dct.length,value:sd(dct)},thisWeek:{count:dcw.length,value:sd(dcw)},thisMonth:{count:dcm.length,value:sd(dcm)}},closedWon:{thisMonth:{count:cwm.length,value:sd(cwm)}},recentDeals:rd}})};
  }catch(err){console.error('Dashboard error:',err);return{statusCode:500,headers,body:JSON.stringify({error:err.message})};}
};