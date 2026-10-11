// Account catalog metadata only. This does not infer runtime selectability or produce profiles.
export function projectWorkCatalog(data) {
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(x);
  const label=x=>typeof x==='string'&&x.length<=160&&!/[\x00-\x1f\x7f]/.test(x);
  const bool=x=>typeof x==='boolean';
  const restrictions=(src,out,path)=>{for(const key of ['enabled','disabled','hidden','is_hidden','admin_only','is_admin_only','disabled_by_admin'])field(src,out,key,bool,path);field(src,out,'tags',strings,path);};
  const issues=[];let issueCount=0,criticalIssueCount=0,optionalIssueCount=0;
  const optional=path=>/\.(?:id|model_version|title|selected_display_title|human_category_name|human_category_short_name|full_label|short_label|mobile_full_label)$/.test(path);
  const issue=path=>{issueCount++;if(optional(path))optionalIssueCount++;else criticalIssueCount++;if(issues.length<256)issues.push({path,critical:!optional(path)});};
  const field=(src,out,key,valid,path)=>{if(!Object.hasOwn(src,key))return;if(src[key]===null||valid(src[key]))out[key]=src[key];else issue(path+'.'+key);};
  const strings=x=>Array.isArray(x)&&x.length<=256&&x.every(id);
  const rows=(src,out,key,project,path,limit=256)=>{
    if(!Object.hasOwn(src,key))return;if(src[key]===null){out[key]=null;return;}
    if(!Array.isArray(src[key])||src[key].length>limit){issue(path+'.'+key);return;}
    out[key]=src[key].flatMap((row,i)=>{if(!object(row)){issue(path+'.'+key+'['+i+']');return [];}return [project(row,path+'.'+key+'['+i+']')];});
  };
  const tier=(src,path)=>{const out={};field(src,out,'service_tier',id,path);return out;};
  const effort=(src,path)=>{const out={};field(src,out,'thinking_effort',id,path);for(const k of ['full_label','short_label','mobile_full_label'])field(src,out,k,label,path);return out;};
  const model=(src,path)=>{
    const out={};for(const k of ['slug','reasoning_type','default_thinking_effort','default_service_tier'])field(src,out,k,id,path);
    field(src,out,'title',label,path);
    for(const k of ['is_work_mode_model','configurable_thinking_effort'])field(src,out,k,bool,path);
    restrictions(src,out,path);rows(src,out,'thinking_efforts',effort,path);rows(src,out,'service_tier_options',tier,path);return out;
  };
  const category=(src,path)=>{
    const out={};for(const k of ['category','default_model','model_lane','model_version'])field(src,out,k,id,path);
    restrictions(src,out,path);field(src,out,'supported_models',strings,path);for(const k of ['is_soft_deprecated'])field(src,out,k,bool,path);
    for(const k of ['human_category_name','human_category_short_name'])field(src,out,k,label,path);
    field(src,out,'hard_deprecation_date',x=>typeof x==='string'&&/^\d{4}-\d\d-\d\d(?:T[0-9:.Z+-]+)?$/.test(x),path);return out;
  };
  const preset=(src,path)=>{
    const out={};for(const k of ['id','preset_type','model_slug','thinking_effort','lane','default_service_tier'])field(src,out,k,id,path);
    for(const k of ['title','selected_display_title'])field(src,out,k,label,path);
    restrictions(src,out,path);rows(src,out,'service_tier_options',tier,path);return out;
  };
  const version=(src,path)=>{
    const out={};field(src,out,'id',id,path);field(src,out,'slugs',strings,path);
    restrictions(src,out,path);rows(src,out,'intelligence_presets',preset,path,128);return out;
  };
  const out={};
  if(!object(data)){issue('$');return {status:'schema_unrecognized',source:'work_models_response',schema:{issue_count:issueCount,critical_issue_count:criticalIssueCount,optional_issue_count:optionalIssueCount,issues}};}
  field(data,out,'default_model_slug',id,'$');field(data,out,'workspace_editor_catalog',bool,'$');
  rows(data,out,'slider_settings',(src,path)=>{const row={};for(const k of ['model_slug','thinking_effort'])field(src,row,k,id,path);return row;},'$');
  if(Object.hasOwn(data,'workspace_model_policy')){
    if(data.workspace_model_policy===null)out.workspace_model_policy=null;
    else if(object(data.workspace_model_policy)){
      const policy=data.workspace_model_policy,p={};
      if(Object.hasOwn(policy,'selection')){if(policy.selection===null)p.selection=null;else if(object(policy.selection)){p.selection={};for(const k of ['model','thinking_effort','speed_tier'])field(policy.selection,p.selection,k,id,'$.workspace_model_policy.selection');}else issue('$.workspace_model_policy.selection');}
      field(policy,p,'new_thread_precedence',x=>id(x)||bool(x)||strings(x),'$.workspace_model_policy');out.workspace_model_policy=p;
    }else issue('$.workspace_model_policy');
  }
  rows(data,out,'models',model,'$');rows(data,out,'categories',category,'$');rows(data,out,'versions',version,'$');
  const observed=Array.isArray(out.models)&&out.models.length>0;
  return {status:observed?(issueCount?'ok_partial':'ok'):'schema_unrecognized',source:'work_models_response',...out,
    schema:{issue_count:issueCount,critical_issue_count:criticalIssueCount,optional_issue_count:optionalIssueCount,issues},observation_scope:'account_catalog',catalogObserved:observed,catalogSelectable:'unverified',runtimeSelectable:'unknown',request_submission_tested:false};
}
