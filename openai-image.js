const OPENAI_IMAGE_URL='https://api.openai.com/v1/images/generations';

export async function generateOpenAIImage(prompt){
  const key=String(process.env.OPENAI_API_KEY||'').trim();
  if(!key) throw Object.assign(new Error('OPENAI_API_KEY missing'),{publicCode:'image_unavailable'});
  const model=String(process.env.OPENAI_IMAGE_MODEL||'gpt-image-1').trim();
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),120000);
  try{
    const response=await fetch(OPENAI_IMAGE_URL,{
      method:'POST',
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,prompt:String(prompt).slice(0,32000),size:'1024x1024',n:1}),
      signal:controller.signal
    });
    const raw=await response.text();
    let data={}; try{data=JSON.parse(raw)}catch{}
    if(!response.ok){
      const msg=String(data?.error?.message||raw||'OpenAI image error');
      if(response.status===429||/quota|rate.?limit|billing|credit/i.test(msg)) throw Object.assign(new Error(msg),{publicCode:'image_quota'});
      throw Object.assign(new Error(msg),{publicCode:'image_unavailable'});
    }
    const item=data?.data?.[0];
    if(item?.b64_json) return {mimeType:'image/png',data:item.b64_json,model};
    if(item?.url){
      const imageResponse=await fetch(item.url,{signal:controller.signal});
      if(!imageResponse.ok) throw new Error('Could not download generated image');
      const buffer=Buffer.from(await imageResponse.arrayBuffer());
      return {mimeType:imageResponse.headers.get('content-type')||'image/png',data:buffer.toString('base64'),model};
    }
    throw Object.assign(new Error('OpenAI returned no image'),{publicCode:'image_unavailable'});
  }finally{clearTimeout(timeout)}
}
