// Strict privacy uses a direct, text-only request: no repository, tools, global
// OpenCode configuration or hidden workspace context can bypass the gateway.
export async function privateGenerate(model,message,output,timeout,{fetcher=fetch}={}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Private generation deadline exhausted');
  if (!/^(google|verda-nemotron)\//.test(model)) throw new Error('Unsupported private generation provider');
  const google=model.startsWith('google/');
  const url=google?`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.split('/')[1])}:generateContent`:`${process.env.KATSE_VERDA_URL || 'https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1'}/chat/completions`;
  const body=google?{contents:[{role:'user',parts:[{text:message}]}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:output,thinkingConfig:{thinkingLevel:'low'}}}:{model:process.env.KATSE_VERDA_MODEL || 'nemotron-3.5-super-vl',messages:[{role:'user',content:message}],max_tokens:output,chat_template_kwargs:{enable_thinking:false}};
  const headers=google?{'x-goog-api-key':process.env.GEMINI_API_KEY}:{Authorization:`Bearer ${process.env.VERDA_INFERENCE_KEY}`};
  const begin=Date.now();
  const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.floor(timeout))),headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error(`Private text generation HTTP ${response.status}`);
  const data=await response.json();
  const text=google?(data.candidates?.[0]?.content?.parts || []).filter(p=>!p.thought).map(p=>p.text||'').join(''):data.choices?.[0]?.message?.content;
  const total=google?data.usageMetadata?.totalTokenCount:data.usage?.total_tokens;
  const length=google?data.candidates?.[0]?.finishReason==='MAX_TOKENS':data.choices?.[0]?.finish_reason==='length';
  return {code:0,ms:Date.now()-begin,stderr:'',stdout:[{type:'text',text:text || ''},{type:'step_finish',part:{reason:length?'length':'stop',tokens:Number.isFinite(total)?{total}:{}}}].map(e=>JSON.stringify(e)).join('\n')};
}
