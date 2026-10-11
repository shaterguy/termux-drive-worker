import { selectReadableOfficialToken, assertReadableSignalUnique } from './profile-readable-signals.mjs';
import { createHash } from 'node:crypto';
import { buildProfile, fingerprint, operationsFromRequest } from './profile-registry-sync.mjs';
import { NormalChatCatalogSource, collectNormalChatCatalog } from './profile-chat-source.mjs';

const own=(v,k)=>Object.hasOwn(v,k);
const efforts=new Set(['min','standard','extended','xhigh','max','ultra']);
const token=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(x);
const fail=()=>{throw Error('WORK_NATIVE_MAPPING_UNVERIFIED');};
const hash=value=>createHash('sha256').update(value).digest('hex');
function flags(row){if(!row||typeof row!=='object'||Array.isArray(row))fail();if(own(row,'tags')&&(!Array.isArray(row.tags)||row.tags.length>256||!row.tags.every(token)))fail();for(const key of ['enabled','disabled_by_admin','disabled','hidden','is_hidden','admin_only','is_admin_only'])if(own(row,key)&&row[key]!==null&&typeof row[key]!=='boolean')fail();}
const restrictedTags=['hidden','is_hidden','admin_only','is_admin_only'];
const hasRestrictedTags=row=>Array.isArray(row.tags)&&row.tags.some(tag=>restrictedTags.includes(tag));
const excluded=row=>row.enabled===false||['disabled_by_admin','disabled','hidden','is_hidden','admin_only','is_admin_only'].some(key=>row[key]===true)||hasRestrictedTags(row);
function label(value){return typeof value==='string'&&[...value].length<=100&&!/[\p{Cc}\p{Cs}]/u.test(value)?value:null;}
function paths(values){const result=[...new Set(values)];if(result.length>16||result.some(x=>typeof x!=='string'||[...x].length>256||/[\p{Cc}\p{Cs}]/u.test(x)))fail();return result;}
function tiers(row) {
  if(!own(row,'service_tier_options'))return undefined;
  if(row.service_tier_options===null)return [];
  if(!Array.isArray(row.service_tier_options)||row.service_tier_options.length>16)fail();
  const list=row.service_tier_options.map(t=>t?.service_tier);
  if(list.some(t=>!['standard','fast'].includes(t))||new Set(list).size!==list.length)fail();
  return list;
}
export function parseWorkCatalog(catalog) {
  if(!['ok','ok_partial'].includes(catalog?.status)||!Array.isArray(catalog.models)||!Array.isArray(catalog.versions)||!Array.isArray(catalog.categories))fail();
  const schema=catalog.schema;
  if(!schema||!Number.isSafeInteger(schema.issue_count)||schema.issue_count<0)fail();
  if(schema.issue_count>0&&(!Number.isSafeInteger(schema.critical_issue_count)||schema.critical_issue_count!==0||schema.optional_issue_count!==schema.issue_count))fail();
  if((Number.isSafeInteger(schema.critical_issue_count)&&Number.isSafeInteger(schema.optional_issue_count)&&schema.critical_issue_count+schema.optional_issue_count!==schema.issue_count)||schema.critical_issue_count>0||catalog.models.length>256||catalog.versions.length>256||catalog.categories.length>256)fail();
  const models=new Map(),categoryModels=new Set();
  for(const model of catalog.models){if(!token(model?.slug)||models.has(model.slug)||(own(model,'tags')&&(!Array.isArray(model.tags)||!model.tags.every(token))))fail();flags(model);models.set(model.slug,model);}
  for(const category of catalog.categories){
    flags(category);
    if(!Array.isArray(category.supported_models)||!category.supported_models.every(token))fail();
    if(!excluded(category))for(const model of category.supported_models)categoryModels.add(model);
  }
  let completeMapping=true;
  const readableModels=new Map(),readableSignals=new Map(),readableMetadata=new Map(),mappedRequests=new Map();
  const observedAt=new Date().toISOString(), profiles=new Map(), policies=new Map(), presentation=new Map(), held=[];
  for(const [versionIndex,version] of catalog.versions.entries()){
    flags(version);
    if(typeof version?.enabled!=='boolean')fail();

    if(!Array.isArray(version.slugs)||!version.slugs.every(token)||!Array.isArray(version.intelligence_presets))fail();
    for(const [presetIndex,preset] of version.intelligence_presets.entries()){
      if(preset?.preset_type==='upgrade')continue;
      if(preset?.preset_type!=='available'||!token(preset.model_slug))fail();
      flags(preset);
      const model=models.get(preset.model_slug),effort=preset.thinking_effort;
      if(!model||!version.slugs.includes(model.slug))fail();
      const matchingCategories=catalog.categories.map((row,index)=>({row,index})).filter(x=>x.row.supported_models.includes(model.slug));
      if(matchingCategories.length===0)fail();
      const restrictions=[];
      const restrict=(row,path)=>{for(const key of ['disabled_by_admin','disabled','hidden','is_hidden','admin_only','is_admin_only'])if(row[key]===true)restrictions.push(path+'.'+key);if(row.enabled===false)restrictions.push(path+'.enabled');if(hasRestrictedTags(row))restrictions.push(path+'.tags');};
      restrict(model,`models[${catalog.models.indexOf(model)}]`);restrict(version,`versions[${versionIndex}]`);restrict(preset,`versions[${versionIndex}].intelligence_presets[${presetIndex}]`);
      if(version.enabled!==true)restrictions.push(`versions[${versionIndex}].enabled`);
      if(!categoryModels.has(model.slug))for(const entry of matchingCategories)restrict(entry.row,`categories[${entry.index}]`);
      const availabilityStatus=restrictions.length?'observed_unavailable':'observed_selectable';
      if(model.is_work_mode_model!==true||model.reasoning_type!=='reasoning'){if(restrictions.length){completeMapping=false;continue;}fail();}
      const state=own(preset,'thinking_effort')?(effort===null?'null':'present'):'absent';
      if(preset.field_states?.thinking_effort){const field=preset.field_states.thinking_effort;if((field.state==='absent')!==(state==='absent')||(state!=='absent'&&field.type!==(state==='null'?'null':typeof effort)))fail();}
      if(state!=='present'){held.push({identity:{versionId:token(version.id)?version.id:null,modelSlug:model.slug,presetIndex,thinkingEffortState:state},reason:state==='null'?'explicit_null_effort_unmapped':'WORK_EFFORT_MAPPING_UNVERIFIED'});continue;}
      if(!efforts.has(effort)||!Array.isArray(model.thinking_efforts)||!model.thinking_efforts.some(e=>(typeof e==='string'?e:e?.thinking_effort)===effort)){if(restrictions.length){completeMapping=false;continue;}fail();}
      const options=tiers(preset)??tiers(model)??[];
      const defaultTier=own(preset,'default_service_tier')?preset.default_service_tier:model.default_service_tier;
      if(defaultTier!==undefined&&defaultTier!==null&&!['standard','fast'].includes(defaultTier))fail();
      const tier=options.includes(defaultTier)?defaultTier:options[0];
      const request={model:model.slug,thinking_effort:effort,conversation_origin:'tpp',...(tier?{service_tier:tier}:{})};
      const fp=fingerprint('WORK',operationsFromRequest(request));

      const policy={fingerprint:fp,request:{model:model.slug,thinking_effort:effort},options,default_tier:tier??null};
      if(availabilityStatus==='observed_selectable')mappedRequests.set(fp,request);
      if(profiles.size>128)fail();
      const modelIndex=catalog.models.indexOf(model),effortIndex=model.thinking_efforts.findIndex(e=>(typeof e==='string'?e:e?.thinking_effort)===effort),effortRow=model.thinking_efforts[effortIndex];
      const mp=`models[${modelIndex}]`,pp=`versions[${versionIndex}].intelligence_presets[${presetIndex}]`,ep=`${mp}.thinking_efforts[${effortIndex}]`;
      const modelTitle=label(model.title),effortTitle=label(preset.title),selectedDisplayTitle=label(preset.selected_display_title);
      if(availabilityStatus==='observed_selectable'&&!profiles.has(fp)){
        let readableModel,readableEffort;
        try{
          readableModel=selectReadableOfficialToken([{value:modelTitle,sourceField:'modelTitle',sourcePath:mp+'.title'}]);
          readableEffort=selectReadableOfficialToken([
            {value:selectedDisplayTitle,sourceField:'selectedDisplayTitle',sourcePath:pp+'.selected_display_title'},
            {value:effortTitle,sourceField:'effortTitle',sourcePath:pp+'.title'},
            {value:label(effortRow?.short_label),sourceField:'shortLabel',sourcePath:ep+'.short_label'},
            {value:label(effortRow?.full_label),sourceField:'fullLabel',sourcePath:ep+'.full_label'},
            {value:label(effortRow?.mobile_full_label),sourceField:'mobileFullLabel',sourcePath:ep+'.mobile_full_label'}],{officialApiIdentifier:effort,sourceField:'thinkingEffort',sourcePath:pp+'.thinking_effort'});
          if((readableEffort.token+(tier?':'+tier:'')).length>80)throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
        }catch(error){
          if(error.message!=='READABLE_SIGNAL_UNREPRESENTABLE')throw error;
          completeMapping=false;
          held.push({identity:{versionId:token(version.id)?version.id:null,modelSlug:model.slug,thinkingEffort:effort,presetIndex,thinkingEffortState:state},reason:'official_ascii_label_unavailable'});
        }
        if(readableModel&&readableEffort&&(readableEffort.token+(tier?':'+tier:'')).length<=80){
          const signalModel=readableModel.token,signalReasoning=readableEffort.token+(tier?':'+tier:'');
          assertReadableSignalUnique(readableModels,signalModel,model.slug);
          assertReadableSignalUnique(readableSignals,signalModel+':'+signalReasoning,fp);
          profiles.set(fp,buildProfile('WORK',{signalModel,signalReasoning,request}));
          readableMetadata.set(fp,{fingerprint:fp,model:readableModel,reasoning:{...readableEffort,token:signalReasoning,...(tier?{serviceTierSuffix:{value:tier,sourceField:'service_tier',sourcePath:'request.service_tier'}}:{})}});
          if(profiles.size>128)fail();
        }
      }
      if(availabilityStatus==='observed_selectable'&&profiles.has(fp)){if(policies.has(fp))policy.options=[...new Set([...policies.get(fp).options,...options])];policies.set(fp,policy);}
      const sourceFields={modelTitle:mp+'.title',effortTitle:pp+'.title',selectedDisplayTitle:pp+'.selected_display_title',locale:null};
      const origin={observedAt,versionId:token(version.id)?version.id:null,modelSlug:model.slug,thinkingEffortState:state,thinkingEffort:effort,presetIndex,modelTitle,presetTitle:effortTitle,selectedDisplayTitle,fullLabel:label(effortRow?.full_label),shortLabel:label(effortRow?.short_label),mobileFullLabel:label(effortRow?.mobile_full_label),sourceFields:{modelTitle:mp+'.title',presetTitle:pp+'.title',selectedDisplayTitle:pp+'.selected_display_title',fullLabel:ep+'.full_label',shortLabel:ep+'.short_label',mobileFullLabel:ep+'.mobile_full_label'},availabilityStatus,availabilitySourceFields:paths([...restrictions,pp+'.preset_type',mp+'.is_work_mode_model',mp+'.reasoning_type',ep+'.thinking_effort',`versions[${versionIndex}].enabled`,`versions[${versionIndex}].slugs`])};
      if(!presentation.has(fp))presentation.set(fp,{fingerprint:fp,status:availabilityStatus,availabilityObservedAt:observedAt,modelTitle,effortTitle,selectedDisplayTitle,locale:null,labelObservedAt:{modelTitle:modelTitle===null?null:observedAt,effortTitle:effortTitle===null?null:observedAt,selectedDisplayTitle:selectedDisplayTitle===null?null:observedAt,locale:null},sourceFields,origins:[]});
      const row=presentation.get(fp);if(availabilityStatus==='observed_selectable'&&row.status!=='observed_selectable')Object.assign(row,{status:availabilityStatus,availabilityObservedAt:observedAt,modelTitle,effortTitle,selectedDisplayTitle,locale:null,labelObservedAt:{modelTitle:modelTitle===null?null:observedAt,effortTitle:effortTitle===null?null:observedAt,selectedDisplayTitle:selectedDisplayTitle===null?null:observedAt,locale:null},sourceFields});row.origins.push(origin);if(row.origins.length>128)fail();
    }
  }
  if(presentation.size===0&&held.length===0)fail();
  if(presentation.size>128)fail();
  const next=[...profiles.values()], workPolicies=[...policies.values()], display={observedAt,profiles:[...presentation.values()]};
  // Observation timestamps do not create a new identity; label and origin metadata do.
  const identityDisplay=JSON.parse(JSON.stringify(display,(key,value)=>['observedAt','availabilityObservedAt','labelObservedAt'].includes(key)?undefined:value));
  return {profiles:next,current_selectable_zero_verified:next.length===0&&completeMapping&&held.length===0,reconcile_current_profiles:true,catalog_complete:completeMapping&&held.length===0,work_tier_policies:workPolicies,presentation:display,identity:'native-work:'+hash(JSON.stringify({profiles:next,policies:workPolicies,presentation:identityDisplay,held})),catalog_metadata:{source:'account_work_catalog',held_observations:held,available_preset_count:mappedRequests.size,mapped_request_count:mappedRequests.size,readable_signal_observations:[...readableMetadata.values()],official_effort_identifier_fallback_count:[...readableMetadata.values()].filter(row=>row.reasoning.sourceKind==='verified_api_effort_identifier').length,model_count:new Set(next.map(p=>p.request.model)).size,optional_projection_issue_count:schema.optional_issue_count??0,runtime_selectability:'unknown',request_submission_tested:false,soft_deprecated_categories:catalog.categories.filter(c=>c.is_soft_deprecated===true).map(c=>({category:c.category,hard_deprecation_date:c.hard_deprecation_date??null})),temporary_absence_is_permanent_deactivation:false}};
}
export class WorkCatalogSource extends NormalChatCatalogSource {
  constructor(options={}){super({...options,collect:options.collect??(args=>collectNormalChatCatalog({...args,catalogKind:'WORK'})),parser:parseWorkCatalog});}
}
