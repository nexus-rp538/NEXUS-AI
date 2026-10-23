(()=>{
  const imageWords=/(صورة|صوره|صور|لوجو|شعار|بوستر|تصميم|شكل|هود|واجهة|واجهه|image|picture|logo|poster|artwork|mockup)/i;
  const imageIntent=/(وريني|ورنى|اعرضلي|اعرض لى|اعرض لي|عايز اشوف|عاوز اشوف|نفسي اشوف|تخيل|اعمل|اعملي|اعمللي|اعمل لي|انشئ|أنشئ|ولد|ولّد|صمم|ارسم|generate|create|make|design|draw|show me|visualize)/i;
  const originalAppend=FormData.prototype.append;
  FormData.prototype.append=function(name,value,...rest){
    if(name==='message' && typeof value==='string'){
      const text=value.trim();
      if(imageWords.test(text) && imageIntent.test(text) && !/^(اعمل|اعملي|انشئ|أنشئ|ولد|ولّد|صمم|ارسم|generate|create|make|design|draw)/i.test(text)){
        value=`اعمل صورة فعلية الآن واعرض الصورة نفسها داخل المحادثة، لا تشرحها ولا ترسل كود. طلب المستخدم: ${text}`;
      }
    }
    return originalAppend.call(this,name,value,...rest);
  };
})();
