'use strict';
const app = document.getElementById('app'), dialog = document.getElementById('dialog'), notice = document.getElementById('notice');
const token = location.hash.slice(1);
let language = navigator.language.startsWith('zh') ? 'zh' : 'en';
const state = { role: 'caller', days: 7, page: 'overview', data: null, selected: null, quotas: new Map(), peerChecks: new Map(), refresh: false, stopped: false };
let poll, noticeTimer;
const t = (zh, en) => language === 'zh' ? zh : en;
const statusNames = { budget_exhausted:['Token 预算已用尽','Token budget exhausted'],budget_paused:['Token 用量待确认','Token usage needs review'],expired:['授权已到期','Authorization expired'], available:['可用','Available'], sharing:['共享中','Sharing'], busy:['执行中','Busy'], running:['执行中','Running'], completed:['本轮结束','Turn ended'], failed:['失败','Failed'], interrupted:['已中断','Interrupted'], unchecked:['未检查','Unchecked'], unknown:['待确认','Unknown'], unreachable:['无法连接','Unreachable'], stopped:['已停止共享','Sharing stopped'], starting:['启动中','Starting'], released:['副本已释放','Copy released'], records_deleted:['记录已删除','Records deleted'], all_deleted:['历史已删除','History deleted'] };
const labelStatus = value => statusNames[value] ? t(...statusNames[value]) : value || t('未知','Unknown');
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (text, action, cls = 'button') => el('button', { type:'button', class:cls, onclick:event => perform(action,event.currentTarget) }, text);
const stat = value => el('span', { class:`status ${Object.hasOwn(statusNames,value) ? value : 'unknown'}` }, labelStatus(value));
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(language, {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const minutes = ms => `${(ms / 60000).toLocaleString(language,{maximumFractionDigits:1})} ${t('分钟','min')}`;
const say = text => { clearTimeout(noticeTimer); notice.textContent=text; noticeTimer=setTimeout(()=>{notice.textContent='';},7000); };
async function perform(action, button) {
  if (button) button.disabled=true;
  try { await action(); } catch(error) { say(error.message); }
  finally { if(button) button.disabled=false; }
}
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { Authorization:`Bearer ${token}`, ...(options.body ? {'Content-Type':'application/json'} : {}) } });
  const data = await response.json();
  if(!response.ok) { if(response.status===410) state.stopped=true; throw new Error(data.error); }
  return data;
}
async function call(name,input={}) {
  const result=await api('/api/call',{method:'POST',body:JSON.stringify({name,input})});
  if(result.status==='onboarding_required') { showOnboarding(result.onboarding); throw new Error(t('先确认首次使用设置，再重试此操作。','Review first-use settings, then retry this action.')); }
  return result;
}
function showDialog(title, content) {
  dialog.replaceChildren(el('div',{class:'dialoghead'},el('h2',{id:'dialog-title'},title),btn('×',()=>dialog.close(),'close')),content);
  if(!dialog.open)dialog.showModal();
}
function select(options,value,onchange,attrs={}) {
  return el('select',{...attrs,onchange},options.map(([id,label])=>el('option',{value:id,...(id===String(value)?{selected:''}:{})},label)));
}
function field(title,name,value='',type='text',options) {
  let input;
  if(options) input=select(options,value,undefined,{name});
  else if(type==='textarea')input=el('textarea',{name},value);
  else input=el('input',{name,type,value});
  return el('label',{class:'field'},title,input);
}
function check(title,name,checked=false) { return el('label',{class:'check'},el('input',{name,type:'checkbox',checked}),title); }
function form(fields,submit,buttonText=t('保存','Save')) {
  const error=el('p',{class:'error',role:'alert'}), button=el('button',{type:'submit',class:'button primary'},buttonText);
  const node=el('form',{},fields,error,button);
  node.addEventListener('submit',event=>{event.preventDefault();perform(async()=>{error.textContent='';try{await submit(new FormData(node));}catch(e){error.textContent=e.message;}},button);});
  return node;
}
function confirmation(title,description,action) {
  showDialog(title,el('div',{},el('p',{class:'info'},description),btn(t('确认','Confirm'),async()=>{await action();dialog.close();await refresh();},'button danger')));
}
function quotaView(key) {
  const data=state.quotas.get(key);
  if(!data)return el('div',{class:'quota'});
  const lines=[];
  for(const limit of data.limits || []) for(const window of [limit.primary,limit.secondary].filter(Boolean)) {
    const duration=window.windowDurationMins == null ? t('窗口','Window') : window.windowDurationMins >= 1440 ? `${window.windowDurationMins/1440} ${t('天','days')}` : `${window.windowDurationMins/60} ${t('小时','hours')}`;
    lines.push(el('div',{},`${limit.limitName || limit.limitId} · ${duration}`,el('strong',{},window.status==='stale' || window.resetsAt && window.resetsAt*1000<=Date.now()?t('已过期，请刷新','Expired; refresh'):window.remainingPercent==null?'—':`${window.remainingPercent}%`)));
    if(window.resetsAt)lines.push(el('p',{class:'sub'},`${t('重置','Resets')} ${time(new Date(window.resetsAt*1000).toISOString())}`));
  }
  if(!lines.length)lines.push(el('p',{class:'sub'},data.reason || t('暂不可用','Unavailable')));
  return el('div',{class:'quota'},el('p',{class:'sub'},t('账号额度','Account quota')),lines,el('p',{class:'sub'},`${data.status} · ${time(data.checkedAt)}`));
}
async function queryQuota(peer) { const key=peer || '$local'; state.quotas.delete(key); render(); state.quotas.set(key,await call('resource_usage',peer?{peer}:{}));render(); }
async function queryModels(peer) {
  const result=await call('list_models',peer?{peer}:{});
  showDialog(t('可用模型','Available models'),el('div',{},(result.models || []).map(model=>el('div',{class:'setting'},el('h3',{},model.displayName || model.model),el('p',{},model.model),el('p',{class:'sub'},(model.reasoningEfforts || []).join(' · ')))),el('p',{class:'sub'},time(result.checkedAt))));
}
function delivery(task) {
  if(task.localFilesCleaned)return t('本地文件已清理','Local files cleared');
  if(state.role==='provider')return task.saveConfirmed && task.savedRevision===task.revision ? t('使用端已保存','Saved by client') : t('等待使用端保存','Awaiting client save');
  if(task.deliveryPending===true)return task.savedAt?t('上次成果已保存 · 本轮待取回','Previous save · latest pending'):t('尚未保存到本机','Not saved locally');
  if(task.savedAt&&task.skipped?.length)return t('已保存 · 有跳过文件','Saved · files skipped');
  if(task.savedAt)return t('成果已保存','Results saved');
  return t('保存状态未知','Save status unknown');
}
function taskSummary(task) {
  const short=task.taskId.slice(0,12);
  const node=el('div',{class:'task'},el('span',{class:'time'},time(task.endedAt || task.createdAt)),el('div',{},btn(short,()=>openTask(task),'link mono'),el('p',{class:'sub'},`${task.peerDisplayName || task.peer || task.pairId?.slice(0,8) || ''} · ${task.harness || 'Codex'}`),el('p',{class:'mobile-delivery'},delivery(task))),stat(task.cleanupStatus || task.status || 'unknown'),el('span',{class:'desktop-delivery sub'},delivery(task)),btn('↗',()=>openTask(task),'arrow'));
  node.querySelector('.arrow').setAttribute('aria-label',`${t('查看任务','View task')} ${task.taskId}`);
  const wrap=el('div',{},node);
  if(state.selected?.task.taskId===task.taskId)wrap.append(taskDetail(state.selected));
  return wrap;
}
async function openTask(task) {
  if(state.selected?.task.taskId===task.taskId){state.selected=null;render();return;}
  const saved=state.role==='caller'?await api(`/api/task?id=${encodeURIComponent(task.taskId)}`):null;
  state.selected={task,saved,remote:null,answer:null,file:null};
  if(saved?.responseFile)state.selected.answer=await api(`/api/file?id=${encodeURIComponent(task.taskId)}&answer=true`);
  render();
}
async function taskAction(name,input) {
  const result=await call(name,input);
  if(name==='task_status'&&state.selected){state.selected.remote=result;render();return;}
  say(result.note || labelStatus(result.status));
  state.selected=null;await refresh();
}
async function download(task,name,answer=false) {
  const response=await fetch(`/api/file?id=${encodeURIComponent(task.taskId)}&path=${encodeURIComponent(name)}&answer=${answer}&download=true`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error((await response.json()).error);
  const url=URL.createObjectURL(await response.blob()), link=el('a',{href:url,download:name});
  link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function taskDetail(selected) {
  const {task,saved,remote,answer,file}=selected, current=remote || task;
  const rows=[[t('任务','Task'),task.taskId],[t('执行状态','Execution'),`${labelStatus(current.status || current.cleanupStatus || 'unknown')} · ${remote?t('刚刚查询','Just checked'):t('最后记录','Last recorded')}`],[t('成果','Delivery'),delivery(task)],[t('保留期限','Retention'),time(current.expiresAt)],[t('工作副本','Work copy'),labelStatus(current.cleanupStatus || current.cleanup?.status || (current.inspection?.workCopyExists===false?'released':'unknown'))]];
  if(current.keepSessionVisible!==undefined) rows.push([t('会话模式','Session mode'),current.keepSessionVisible?t('保留在任务列表','Keep in task list'):t('每轮结束后归档','Archive after each turn')]);
  if(current.sessionVisibility) rows.push([t('会话展示状态','Session visibility'),({archived:t('已归档，续作时恢复','Archived; restores on continuation'),visible:t('未归档','Not archived'),error:t('操作失败，请查看下方说明','Operation failed; see details below')})[current.sessionVisibility.status] || current.sessionVisibility.status]);
  const controls=state.role==='caller'?[
    btn(t('更新状态','Check status'),()=>taskAction('task_status',{taskId:task.taskId})),
    btn(t('取回成果','Collect results'),()=>taskAction('collect_result',{taskId:task.taskId})),
    btn(t('取消本轮','Cancel turn'),()=>confirmation(t('取消本轮','Cancel turn'),t('请求停止当前轮次，之后查询状态确认是否已停止。已有成果保留。','Request interruption, then check whether the turn stopped. Existing results are retained.'),()=>taskAction('cancel_task',{taskId:task.taskId}))),
    btn(t('清理','Clean up'),()=>cleanupTask(task))
  ]:[btn(t('取消本轮','Cancel turn'),()=>confirmation(t('取消本轮','Cancel turn'),t('停止这项任务的当前轮次，保留已有成果。','Request interruption of this task; retain its results.'),()=>taskAction('cancel_shared_task',{pairId:task.pairId,taskId:task.taskId}))),btn(t('清理','Clean up'),()=>cleanupTask(task))];
  return el('section',{class:'detail'},el('div',{class:'sectionhead'},el('h2',{},t('任务详情','Task details')),btn('×',()=>{state.selected=null;render();},'close')),el('dl',{},rows.flatMap(([a,b])=>[el('dt',{},a),el('dd',{},b)])),current.error?el('p',{class:'error'},current.error):null,current.sessionVisibility?.error?el('p',{class:'error'},current.sessionVisibility.error):null,saved?.delivery?el('div',{class:'info'},el('p',{},`${t('本次保存','Saved delivery')} · ${labelStatus(saved.delivery.status)} · ${t('第','Revision')} ${saved.delivery.revision} ${t('轮','')}`),saved.delivery.stopReason==='time_limit'?el('p',{},t('达到执行时限，仅保存阶段成果。','Execution reached its deadline; stage results only.')):null,saved.delivery.error?el('p',{class:'error'},saved.delivery.error):null,saved.delivery.skipped.length?el('div',{},el('p',{},t('以下路径未包含在成果中。必要文件需补齐后再清理。','These paths are missing from the delivery. Recover necessary files before cleanup.')),el('ul',{},saved.delivery.skipped.map(name=>el('li',{},name)))):null):null,el('div',{class:'actions'},controls),el('details',{},el('summary',{},t('轮次用量','Turn usage')),usageDetails((current.rounds || task.rounds || []).flatMap(round=>(round.usage?.models?.length?round.usage.models:[round.usage || {}]).map(model=>({taskId:task.taskId,revision:round.revision,startedAt:round.startedAt,endedAt:round.endedAt,resource:task.peer || task.pairId,harness:task.harness,requestedModel:round.usage?.requestedModel,actualModel:model.actualModel,source:round.usage?.source,usageStatus:round.usage?.status,reason:round.usage?.reason,tokens:model.tokens,observedAt:round.usage?.observedAt,syncStatus:state.role==='provider'?'local':task.deliveryPending && round.revision>(task.savedRevision ?? 0)?'pending':'received',savedAt:task.savedAt}))))),saved?.workCopyDirectory?el('p',{class:'file-path'},saved.workCopyDirectory):null,
    saved?.files.map(name=>el('div',{class:'file'},el('span',{class:'filename small'},name),btn(t('预览','Preview'),async()=>{selected.file={name,...await api(`/api/file?id=${encodeURIComponent(task.taskId)}&path=${encodeURIComponent(name)}`)};render();}),btn(t('下载','Download'),()=>download(task,name)))),
    saved?.responseFile?el('div',{class:'file'},el('span',{class:'filename small'},t('共享端答复','Host answer')),btn(t('下载','Download'),()=>download(task,'response.md',true))):null,
    answer?el('pre',{class:'answer'},answer.text,answer.truncated?`\n${t('内容已截断，可下载完整文件。','Truncated; download the full file.')}`:''):null,
    file?el('div',{},el('h3',{},file.name),el('pre',{class:'answer'},file.text,file.truncated?`\n${t('内容已截断。','Truncated.')}`:'')):null,
    el('p',{class:'sub'},t('已保存成果可离线查看。任务指令和追问继续在原对话中进行。','Saved results work offline. Continue task instructions and follow-ups in the original conversation.')));
}
function cleanupTask(task) {
  const provider=state.role==='provider';
  showDialog(t('清理任务','Clean up task'),el('div',{},el('p',{class:'info'},`${task.taskId}\n${delivery(task)}\n${t('工作副本清理保留恢复资料；删除记录会失去续作关联并删除对应统计；删除全部还会删除原生会话历史。本地已保存成果保留。','Work-copy cleanup retains recovery data. Record deletion removes continuation and statistics. All-history cleanup also deletes native history. Saved local results remain.')}`),
    form([field(t('清理范围','Scope'),'cleanup','workcopy','select',[['workcopy',t('仅远端工作副本','Remote work copy')],['records',t('工作副本与任务记录','Work copy and task records')],['all',t('全部，包含原生历史','All, including native history')]]),provider?check(t('明确丢弃这项任务尚未被使用端取回的成果','Explicitly discard this task’s uncollected results'),'discard'):field(t('明确丢弃的跳过文件，每行一个；无则留空','Explicitly discard skipped files, one per line; otherwise empty'),'discardPaths','','textarea'),check(t('我已确认此清理范围及其影响','I confirm this cleanup scope and its consequences'),'confirmed')],async values=>{
      if(!values.has('confirmed'))throw new Error(t('请确认清理范围。','Confirm the cleanup scope.'));
      const input={taskId:task.taskId,cleanup:values.get('cleanup')};
      if(provider)Object.assign(input,{pairId:task.pairId,discardUncollected:values.has('discard')});
      else {const paths=String(values.get('discardPaths')).split('\n').map(v=>v.trim()).filter(Boolean);if(paths.length)input.discardPaths=paths;}
      await taskAction(provider?'cleanup_shared_task':'finish_task',input);dialog.close();
    },t('执行清理','Clean up'))));
}
async function pairingSettings(peer) {
  const saved=await call('pairing_settings',{pairId:peer.pairId});
  let localDeadline='';
  if(saved.expiresAt){const date=new Date(saved.expiresAt);localDeadline=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}
  const settingsForm=form([
    field(t('连接并发上限，留空则不额外限制','Connection concurrency limit; blank for no extra limit'),'maxConcurrent',saved.maxConcurrent??'','number'),
    field(t('累计 Token 上限，留空则不启用','Cumulative Token limit; blank to disable'),'tokenLimit',saved.budget?.limit??'','number'),
    budgetView(saved.budget),
    el('p',{class:'info'},t('每轮结束后计入用量，达限后停止新执行。正在执行的轮次可以超额，并发时超额可能更大。删除任务、关闭预算或重启不会清零；不等于账号剩余额度。','Usage settles after each turn and blocks new execution at the limit. In-flight turns can overshoot, especially with concurrency. Deletion, disabling and restart do not reset usage. This is separate from account quota.')),
    saved.budget?.status==='paused'?check(t('我已确认原执行停止，接受缺失用量并恢复新执行；已知消耗和不完整标记保留','I confirmed prior execution stopped and accept missing usage to resume; known consumption and the incomplete marker remain'),'acceptUsageGap'):null,
    field(t('授权截止时间（本机时区），留空则不过期','Authorization deadline (local time); blank for no expiry'),'expiresAt',localDeadline,'datetime-local'),
    el('p',{class:'info'},t('仍受节点总并发限制。到期后停止新执行，已有轮次可以收尾、查询和取回成果。任务活动不会自动续期；延长此处期限即可恢复使用。','Node capacity still applies. Expiry stops new execution; active turns may finish and existing work remains accessible. Activity does not renew access; extend this deadline to resume use.'))
  ],async values=>{
    const deadline=values.get('expiresAt');
    const input={pairId:peer.pairId}, limit=values.get('maxConcurrent')?Number(values.get('maxConcurrent')):null;
    if(limit!==saved.maxConcurrent)input.maxConcurrent=limit;
    const tokenLimit=values.get('tokenLimit')?Number(values.get('tokenLimit')):null;
    if(tokenLimit!==(saved.budget?.limit??null))input.tokenLimit=tokenLimit;
    if(values.has('acceptUsageGap'))input.acceptUsageGap=true;
    if(deadline!==localDeadline)input.expiresAt=deadline?new Date(deadline).toISOString():null;
    await call('pairing_settings',input);
    dialog.close();await refresh();say(t('连接规则已保存','Connection rules saved'));
  });
  localDeadline=settingsForm.elements.expiresAt.value;
  settingsForm.elements.maxConcurrent.min='1';settingsForm.elements.maxConcurrent.step='1';settingsForm.elements.expiresAt.step='1';
  settingsForm.elements.tokenLimit.min='1';settingsForm.elements.tokenLimit.step='1';
  showDialog(t('连接规则 · ','Connection rules · ')+peer.name,settingsForm);
}
function budgetView(budget) {
  if(!budget)return null;
  return el('p',{class:'sub'},`${t('Token 预算','Token budget')}: ${budget.usedTokens.toLocaleString(language)} / ${budget.limit===null?t('未启用','Disabled'):budget.limit.toLocaleString(language)}${budget.remainingTokens===null?'':` · ${t('剩余','Remaining')} ${budget.remainingTokens.toLocaleString(language)}`}${budget.pendingRounds?` · ${budget.pendingRounds} ${t('轮待结算','unsettled turns')}`:''}${budget.incomplete?` · ${t('含未计全用量','Includes incomplete usage')}`:''}${budget.status==='paused'?` · ${t('已暂停新执行','New execution paused')}`:''}`);
}
function connection(peer) {
  const related=state.data.tasks.filter(task=>task.peer===peer.name);
  showDialog(peer.displayName || peer.name,el('div',{},el('p',{class:'sub'},state.peerChecks.get(peer.name)?.connectionRoute==='tailcat'?t('本次检查通过跨网络服务连接。是否经过中继未确认。','This check used the cross-network service. Relay use is unconfirmed.'):state.peerChecks.get(peer.name)?.connectionRoute==='direct'?t('本次检查通过私网地址直接连接。','This check connected directly to the private address.'):t('检查连接后可查看本次连接方式。','Check the connection to see its route.')),form([field(t('名称','Name'),'name',peer.name),field(t('新地址，可留空','New address, optional'),'host'),field(t('端口，可留空','Port, optional'),'port','','number')],async values=>{
    const input={peer:peer.name,name:values.get('name')};if(values.get('host'))input.host=values.get('host');if(values.get('port'))input.port=Number(values.get('port'));
    await call('edit_peer',input);state.peerChecks.delete(peer.name);state.quotas.delete(peer.name);dialog.close();await refresh();
  }),el('div',{class:'setting'},el('h3',{},t('文件授权','File consent')),el('p',{class:'sub'},peer.transferAuthorization?.scope==='task-files'?t('已允许发送任务所需文件与指令','Task-file transfer allowed'):t('尚未允许发送任务文件','Task-file transfer not authorized')),btn(t('修改授权','Change consent'),()=>showConsent(peer))),
    el('div',{class:'setting'},el('h3',{},t('跨网络访问','Cross-network access')),el('p',{class:'sub'},peer.crossNetwork?t('此连接已支持跨网络访问。仍受双方设备设置控制。','This connection supports cross-network access, subject to both devices’ settings.'):t('旧连接保持原方式。双方开启服务后，可在保留原任务和授权的情况下迁移。','Existing connections keep their original route. Enable the service on both devices, then migrate while keeping tasks and authorization.')),form([field(t('同一设备的新邀请码，可留空','New invitation from the same device, optional'),'invitation','','textarea')],async values=>{const invitation=String(values.get('invitation')).trim();await call('edit_peer',{peer:peer.name,migrate:true,...(invitation?{invitation}:{})});dialog.close();await refresh();},peer.crossNetwork?t('更新跨网络入口','Update cross-network endpoint'):t('为此连接启用跨网络访问','Enable cross-network access'))),
    el('div',{class:'setting'},el('h3',{},t('删除连接','Remove connection')),el('p',{class:'info'},t('删除后旧任务不能通过重新配对恢复续作。先停止活动任务并取回成果。远端配对与本地成果保留。','Old tasks cannot resume through a new pairing. Stop active work and collect results first. Remote pairing and local results remain.')),related.map(task=>el('p',{class:'small mono'},`${task.taskId} · ${delivery(task)}`)),form([field(t('明确放弃的任务 ID，每行一个；通常留空','Explicitly abandoned task IDs, one per line; normally empty'),'abandon','','textarea'),check(t('确认删除此连接','Confirm removal of this connection'),'confirmed')],async values=>{
      if(!values.has('confirmed'))throw new Error(t('请确认删除。','Confirm removal.'));
      const abandonTasks=String(values.get('abandon')).split('\n').map(v=>v.trim()).filter(Boolean);
      await call('delete_peer',{peer:peer.name,...(abandonTasks.length?{abandonTasks}:{})});dialog.close();await refresh();
    },t('删除连接','Remove connection')))));
}
const consentText=()=>t('以后委托给此设备的任务会发送所需文件与指令，包括必要的非公开源码、文档和配置；凭据、无关文件及需单独授权的敏感材料不在此范围。共享端可以接触这些材料。工作副本按任务保留期及成果保存条件清理，普通清理保留原生历史。撤回授权只停止后续传输，撤回或清理不能收回对方已复制、备份的内容。此设置不替代宿主审批。','Delegated tasks send necessary files and instructions, including private source, documents and configuration. Credentials, unrelated files and separately sensitive material are excluded. The host can access these materials. Work copies follow task retention and saved-result cleanup conditions; ordinary cleanup retains native history. Withdrawal stops future transfers; neither withdrawal nor cleanup recalls existing copies or backups. Managing-app approval still applies.');
function showConsent(peer) {showDialog(t('任务文件授权','Task-file consent'),el('div',{},el('p',{class:'info'},consentText()),form([check(t('允许向此设备发送任务所需文件和指令','Allow task files and instructions to this device'),'allow',peer.transferAuthorization?.scope==='task-files')],async values=>{await call('authorize_peer',{peer:peer.name,allowTaskFiles:values.has('allow')});dialog.close();await refresh();})));}
function pair() {showDialog(t('连接节点','Connect a node'),form([field(t('连接别名，可留空','Connection alias, optional'),'peer'),field(t('私密邀请码','Private invitation'),'invitation','','textarea'),el('p',{class:'info'},consentText()),check(t('允许发送任务所需文件和指令','Allow task-file transfer'),'allow')],async values=>{await call('pair_peer',{...(values.get('peer')?{peer:values.get('peer')}:{}),invitation:values.get('invitation'),allowTaskFiles:values.has('allow')});dialog.close();await refresh();},t('连接','Connect')));}
function invite() {showDialog(t('生成邀请并共享','Create invitation and share'),el('div',{},el('p',{class:'info'},t('这会开启本机共享，允许已授权使用端使用当前执行工具。','This starts local sharing with the selected execution tool for authorized clients.')),form([field(t('监听地址，多网卡时填写','Listen address; specify when multiple interfaces exist'),'address'),field(t('端口，可留空','Port, optional'),'port','','number')],async values=>{const input={};if(values.get('address'))input.address=values.get('address');if(values.get('port'))input.port=Number(values.get('port'));const result=await call('create_pairing',input);showDialog(t('私密邀请','Private invitation'),el('div',{},el('p',{class:'info'},t('仅私下发给预期使用端，一次有效，十分钟后到期。','Share privately with the intended client. One use; expires in ten minutes.')),el('textarea',{readonly:'',class:'answer'},result.invitation)));await refresh();},t('生成邀请','Generate'))));}
const tokenNames=()=>({inputTokens:t('输入','Input'),cachedInputTokens:t('缓存读取','Cache read'),cacheWriteInputTokens:t('缓存写入','Cache write'),outputTokens:t('输出','Output'),reasoningOutputTokens:t('推理输出','Reasoning output'),totalTokens:t('原生总计','Native total')});
const usageStatus=value=>({observed:t('已记录','Recorded'),incomplete:t('部分记录','Partial'),unavailable:t('未采集','Unavailable')}[value] || t('未知','Unknown'));
function tokenText(tokens={},coverage,rounds) {
  return Object.entries(tokenNames()).map(([key,name])=>`${name} ${tokens[key]==null?'—':tokens[key].toLocaleString(language)}${coverage&&coverage[key]<rounds?` (${coverage[key]}/${rounds} ${t('轮已记录','turns recorded')})`:''}`).join(' · ');
}
function exportUsage(statistics) {
  const data={role:statistics.role,days:statistics.days,since:statistics.since,checkedAt:statistics.checkedAt,note:statistics.usageNote,unmeasuredTasks:statistics.unmeasuredTasks,usagePendingTasks:statistics.usagePendingTasks,records:statistics.usageDetails,groups:statistics.usageGroups};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));
  const link=el('a',{href:url,download:`sub2sub-usage-${statistics.role}-${statistics.days}d.json`,hidden:''});
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function usageDetails(records) {
  return records.map(row=>el('div',{class:'setting'},el('h3',{},`${row.taskId.slice(0,12)} · ${t('第','Turn')} ${row.revision} ${t('轮','')}`),el('p',{class:'sub'},`${time(row.startedAt)} · ${row.resource || t('未知资源','Unknown resource')} · ${row.harness}`),el('p',{},`${t('实际模型','Actual model')}: ${row.actualModel || t('未知','Unknown')} · ${t('请求模型','Requested model')}: ${row.requestedModel || '—'}`),el('p',{},tokenText(row.tokens)),el('p',{class:'sub'},`${usageStatus(row.usageStatus)} · ${row.source || t('无来源','No source')} · ${row.syncStatus==='pending'?t('当前轮次或成果待同步','Current turn or delivery pending'):row.syncStatus==='local'?t('共享端本地记录','Host local record'):t('使用端已接收记录','Received by client')}${row.observedAt?` · ${t('观测于','Observed')} ${time(row.observedAt)}`:''}${row.savedAt?` · ${t('成果保存于','Delivery saved')} ${time(row.savedAt)}`:''}`),row.reason?el('p',{class:'sub'},row.reason):null));
}
function usageView(statistics) {
  const groups=statistics.usageGroups || [], records=statistics.usageDetails || [];
  if(!groups.length&&!records.length&&!statistics.usagePendingTasks)return null;
  return el('section',{class:'section'},el('div',{class:'sectionhead'},el('h2',{},t('模型用量','Model usage')),btn(t('导出明细 JSON','Export details JSON'),()=>exportUsage(statistics),'link')),el('p',{class:'sub'},t('— 表示未知','— means unknown')),statistics.usagePendingTasks?el('p',{class:'info'},`${statistics.usagePendingTasks} ${t('项任务有尚未同步的当前轮次或成果；这里可能只有旧轮次记录。','tasks have a pending current turn or delivery; these records may contain only older turns.')}`):null,groups.length?groups.map(group=>el('div',{class:'setting'},el('h3',{},`${group.actualModel || t('实际模型未知','Actual model unknown')} · ${group.resource || t('未知资源','Unknown resource')}`),el('p',{class:'sub'},`${group.harness} · ${group.source || t('无来源','No source')} · ${group.rounds} ${t('轮','turns')}`),el('p',{},tokenText(group.tokens,group.knownFields,group.rounds)),el('p',{class:'sub'},`${group.incompleteRounds} ${t('轮部分记录','partial turns')} · ${group.unavailableRounds} ${t('轮未采集','unavailable turns')} · ${group.pendingRounds} ${t('轮待同步','pending turns')}`))):el('p',{class:'empty'},t('所选时间内暂无用量记录。','No usage records in this period.')),el('details',{},el('summary',{},t('统计口径','About these numbers')),el('p',{class:'sub'},t('仅统计保留记录中的原生数据；— 表示未知，不是零。双方视图对应同一份消耗，不能相加。','Native data from retained records only; — means unknown, not zero. Client and host views describe the same consumption; do not add them together.')),el('p',{class:'sub'},t('Codex 缓存读取包含在输入中、推理包含在输出中；Claude 缓存字段独立。直接展示原生总计，不将分类再相加。Codex 统计主任务，Claude 使用原生分模型结果；两者均不保证涵盖所有辅助调用。','Codex cache reads are included in input and reasoning in output; Claude cache fields are separate. Native totals are shown without adding categories again. Codex records the main thread; Claude uses native per-model results. Neither source guarantees coverage of every auxiliary call.'))),records.length?el('details',{},el('summary',{},t('查看逐轮明细','View turn details')),usageDetails(records)):null);
}
function resources() {
  const {peers,sharing,statistics}=state.data;
  const shown=state.role==='caller'?peers:[{name:state.data.device,...sharing}];
  const rows=shown.map(peer=>{
    const provider=state.role==='provider', key=provider?'$local':peer.name;
    const groups=statistics.resources.filter(g=>provider || g.resource===peer.name);
    const total=groups.reduce((a,g)=>({tasks:a.tasks+g.tasks,rounds:a.rounds+g.rounds,elapsedMs:a.elapsedMs+g.elapsedMs}),{tasks:0,rounds:0,elapsedMs:0});
    return el('div',{class:'resource'},el('div',{},el('div',{class:'resource-title'},el('strong',{},peer.displayName || peer.name),stat(peer.status)),el('p',{class:'sub'},[peer.harness || t('执行工具尚未查询','Execution tool unchecked'),Number.isInteger(peer.occupiedSlots)&&Number.isInteger(peer.maxConcurrent)?`${t('并发','Concurrency')} ${peer.occupiedSlots} / ${peer.maxConcurrent}`:null,peer.checkedAt?`${t('上次检查','Last checked')} ${time(peer.checkedAt)}`:null].filter(Boolean).join(' · ')),budgetView(peer.connection?.budget),peer.connection?.expiresAt?el('p',{class:'sub'},`${t('授权到期','Access expires')} ${time(peer.connection.expiresAt)}`):null,peer.reason?el('p',{class:'error'},peer.reason):null,el('div',{class:'actions'},btn(t('模型','Models'),()=>queryModels(provider?undefined:peer.name),'link'),btn(t('额度','Quota'),()=>queryQuota(provider?undefined:peer.name),'link'),!provider?btn(t('管理','Manage'),()=>connection(peer),'link'):null)),quotaView(key),el('div',{class:'counts'},el('div',{},`${total.tasks} ${t('项任务','tasks')} · ${total.rounds} ${t('轮','turns')}`),el('p',{class:'sub'},`${t('执行','Execution')} ${groups.some(g=>g.timedRounds)?minutes(total.elapsedMs):'—'}`),el('p',{class:'sub'},groups.map(g=>`${g.harness}: ${Object.entries(g.outcomes).map(([status,count])=>`${labelStatus(status)} ${count}`).join(' · ')}`).join(' / '))));
  });
  const total=statistics.totals;
  return el('section',{class:'section'},el('div',{class:'sectionhead'},el('div',{class:'tabs',role:'tablist','aria-label':t('资源角色','Resource role')},['caller','provider'].map(role=>el('button',{type:'button',role:'tab','aria-selected':state.role===role,onclick:()=>perform(async()=>{state.role=role;state.selected=null;await refresh();})},role==='caller'?t('我使用的','Resources I use'):t('我共享的','Resources I share')))),select([['7',t('近 7 天','Last 7 days')],['30',t('近 30 天','Last 30 days')]],state.days,event=>perform(async()=>{state.days=Number(event.target.value);await refresh();}),{class:'period','aria-label':t('统计时间','Statistics period')})),rows.length?el('div',{},rows):el('div',{class:'empty'},el('p',{},t('还没有连接的设备','No connected devices')),el('p',{},t('在另一台电脑生成邀请码，然后在这里连接。','Generate an invitation on the other computer, then connect here.')),btn(t('查看使用方法','Getting started'),help,'link')),total.tasks?el('div',{class:'totals'},el('span',{},`${total.tasks} ${t('项任务','tasks')}`),el('span',{},`${total.rounds} ${t('个轮次','turns')}`),el('span',{},`${t('实际执行','Execution time')} ${total.timedRounds?minutes(total.elapsedMs):'—'}`)):null,statistics.resources.length?el('details',{},el('summary',{},t('统计明细','Statistics details')),statistics.resources.map(g=>el('p',{class:'sub'},`${g.resource || t('未知资源','Unknown resource')} · ${g.harness} · ${g.tasks} ${t('项任务','tasks')} · ${g.rounds} ${t('轮','turns')} · ${g.timedRounds?minutes(g.elapsedMs):'—'} · ${Object.entries(g.outcomes).map(([status,count])=>`${labelStatus(status)} ${count}`).join(' / ')}`))):null,statistics.unmeasuredTasks?el('p',{class:'sub'},`${statistics.unmeasuredTasks} ${t('项记录缺少完整计量，未计为完整历史。','records have incomplete measurements; totals are not complete history.')}`):null,
    el('div',{class:'actions'},state.role==='caller'?btn(t('连接节点','Connect a node'),pair,'link'):btn(t('生成邀请','Create invitation'),invite,'link'),state.role==='provider'?btn(t('停止接单','Stop accepting work'),()=>confirmation(t('停止接单','Stop accepting work'),t('现有任务继续运行，成果仍可取回。','Existing work continues and results remain accessible.'),()=>call('stop_sharing')),'link'):null,state.role==='provider'?btn(t('退出节点','Exit node'),()=>confirmation(t('退出独立节点','Exit independent node'),t('节点退出后远端访问停止。活动轮次必须先结束或取消。','Remote access ends when the node exits. Active turns must finish or be cancelled first.'),()=>call('exit_sharing')),'link'):null),
    state.role==='provider'&&peers.length?el('details',{},el('summary',{},t('已授权使用端','Authorized clients')),peers.map(peer=>el('div',{class:'file'},el('div',{class:'filename'},peer.name,el('p',{class:'sub'},`${t('并发上限','Concurrency limit')}: ${peer.maxConcurrent??t('沿用节点限制','Node limit')} · ${peer.expiresAt?`${peer.authorizationStatus==='expired'?t('已到期','Expired'):t('到期','Expires')} ${time(peer.expiresAt)}`:t('不过期','No expiry')}`),budgetView(peer.budget)),btn(t('规则','Rules'),()=>pairingSettings(peer)),btn(t('撤销授权','Revoke'),()=>confirmation(t('撤销授权','Revoke client'),`${peer.name}\n${t('会中断此使用端的活动任务并撤销后续访问，保留任务记录与成果。','Interrupts this client’s active tasks and revokes future access. Retains task records and results.')}`,()=>call('revoke_pairing',{pairId:peer.pairId,cleanup:'keep'})))))):null);
}
function advancedFields(values,provider=false) {
  const names={inputBytes:t('输入大小上限（MiB）','Input size limit (MiB)'),inputFiles:t('输入文件数上限','Input file count'),resultBytes:t('返回大小上限（MiB）','Result size limit (MiB)'),resultFiles:t('返回文件数上限','Result file count'),retentionDays:t('保留天数','Retention days')};
  return el('details',{},el('summary',{},t('高级设置','Advanced settings')),el('p',{class:'sub'},t('传输上限留空表示不限量。超过 64 MiB 时提示后继续，非局域网连接可能更慢。','Leave transfer limits blank for unlimited. Above 64 MiB, a notice appears and transfer continues; non-local networks may be slower.')),el('div',{class:'fields'},Object.entries(names).filter(([name])=>provider||name!=='retentionDays').map(([name,label])=>{const size=name.endsWith('Bytes'), value=values[name];const control=field(label,name,value==null?'':size?value/1048576:value,'number');if(size)control.querySelector('input').step='any';return control;})));
}
function limits(values) {const result={};for(const name of ['inputBytes','inputFiles','resultBytes','resultFiles','retentionDays'])if(values.has(name) && (name!=='retentionDays'||values.get(name)))result[name]=values.get(name)?(name.endsWith('Bytes')?Math.round(Number(values.get(name))*1048576):Number(values.get(name))):null;return result;}
const bytes = value => value == null ? t('未知','Unknown') : value < 1024 ? `${value} B` : value < 1024*1024 ? `${(value/1024).toFixed(1)} KB` : `${(value/1024/1024).toFixed(1)} MB`;
const storageKind = kind => ({record:t('任务记录','Task record'),result:t('答复与成果','Answer and outputs'),workcopy:t('完整工作副本','Complete work copy'),snapshot:t('输入快照','Input snapshot')}[kind] || kind);
async function storage() {
  const data=await call('local_storage');
  const rows=data.tasks.map(task=>el('div',{class:'setting'},el('h3',{class:'mono'},task.taskId),el('p',{},`${task.peer || ''} · ${bytes(task.bytes)} · ${t('旧成果','Old files')} ${bytes(task.oldBytes)}`),
    el('details',{},el('summary',{},t('文件明细','File details')),task.entries.map(entry=>el('p',{class:'info'},`${storageKind(entry.kind)} · ${bytes(entry.bytes)} · ${entry.current?t('当前引用','Current reference'):t('历史文件','Historical file')}\n${entry.path}${entry.reason?'\n'+entry.reason:''}`))),
    el('div',{class:'actions'},btn(t('清理旧成果','Clear old files'),()=>previewStorage({taskId:task.taskId,scope:'old'}),'link'),btn(t('清理全部本地文件','Clear all local files'),()=>chooseLocalCleanup(task),'link'))));
  showDialog(t('本地空间','Local storage'),el('div',{},el('p',{},`${t('使用端文件总计','Client file total')} ${bytes(data.bytes)}`),el('p',{class:'sub'},t('同一目录在总计中只计一次。大小按文件字节统计，实际释放空间由文件系统决定。','Shared directories count once in the total. File sizes may differ from disk space reclaimed.')),data.errors.map(error=>el('p',{class:'error'},`${error.path}: ${error.reason}`)),rows.length?rows:el('p',{},t('暂无任务文件','No task files')),data.snapshots.map(entry=>el('div',{class:'setting'},el('p',{class:'info'},`${t('未使用的输入快照','Unused input snapshot')} · ${bytes(entry.bytes)}\n${entry.path}`),btn(t('清理快照','Clear snapshot'),()=>previewStorage({snapshotId:entry.snapshotId,scope:'all'}),'link'))),el('p',{class:'sub'},t('共享端工作副本使用原有任务清理入口，保留期不变。','Host work copies use existing task cleanup controls; retention is unchanged.')),btn(t('查看共享端工作副本占用','Inspect host work copies'),async()=>{
    const result=await call('list_shared_tasks',{details:true});
    showDialog(t('共享端工作副本','Host work copies'),el('div',{},result.tasks.length?result.tasks.map(task=>el('p',{class:'info'},`${task.taskId} · ${bytes(task.inspection?.bytes)}${task.inspection?.error?'\n'+task.inspection.error:''}`)):el('p',{},t('暂无工作副本','No work copies')),btn(t('返回本地空间','Back to local storage'),storage)));
  },'link')));
}
function chooseLocalCleanup(task) {
  showDialog(t('选择本地清理范围','Choose local cleanup'),form([el('p',{class:'info'},task.taskId),check(t('同时删除任务记录及对应统计','Also delete the task record and its usage'),'deleteRecord')],values=>previewStorage({taskId:task.taskId,scope:'all',deleteRecord:values.has('deleteRecord')}),t('查看删除预览','Preview deletion')));
}
async function previewStorage(input) {
  const plan=await call('cleanup_local_files',input);
  const impact=input.snapshotId?t('删除尚未使用的输入快照；需要时可以从源文件重新准备。','Deletes an unused input snapshot; prepare it again from source files if needed.'):input.scope==='old'?t('仅清理旧成果，保留最新答复与恢复文件。','Only old files are removed. Latest delivery and recovery files remain.'):t('将删除本地答复、成果和恢复副本。此版本清理后无法继续或重新取回该任务；需要时使用原始输入新建任务。远端文件和源项目不受影响。','Removes local answers, outputs and recovery copies. This version cannot continue or collect this task afterward; start a new task with original inputs if needed. Remote files and source projects are unchanged.');
  showDialog(t('确认本地清理','Confirm local cleanup'),el('div',{},el('p',{},`${t('预计删除','Expected removal')} ${bytes(plan.expectedBytes)}`),el('p',{class:'info'},impact),el('p',{},input.deleteRecord?t('同时删除本地任务记录及对应统计。','Also removes local task history and its usage.'):t('保留任务记录及对应统计。','Keeps task records and usage.')),plan.retainedSharedPaths.length?el('p',{},t('其他任务仍引用的文件会保留。','Files referenced by other tasks are retained.')):null,plan.entries.map(entry=>el('p',{class:'info'},`${storageKind(entry.kind)} · ${bytes(entry.bytes)}\n${entry.path}`)),btn(t('确认删除','Confirm deletion'),async()=>{
    const result=await call('cleanup_local_files',{...input,confirm:true,previewToken:plan.previewToken});await refresh();
    showDialog(t('清理结果','Cleanup result'),el('div',{},el('p',{},`${result.status==='cleaned'?t('清理完成','Cleanup complete'):t('清理未全部完成','Cleanup incomplete')} · ${bytes(result.removedBytes)}`),result.failures.map(error=>el('p',{class:'error'},`${error.path}: ${error.reason}`)),btn(t('返回空间占用','Back to storage'),storage)));
  },'button danger')));
}
async function settings() {
  state.page='settings';render();
  const [caller,provider,guide]=await Promise.all([call('caller_settings',{harness:'codex'}),call('provider_settings'),call('onboarding')]);
  const mount=document.getElementById('settings');if(!mount)return;
  let callerExecution=caller.execution;
  const callerForm=form([field(t('执行工具','Execution tool'),'harness','codex','select',[['codex','Codex'],['claude','Claude Code']]),field(t('默认模型','Default model'),'model',caller.execution.model || ''),field(t('思考强度','Reasoning effort'),'reasoningEffort',caller.execution.reasoningEffort || '','select',[['',t('未设置','Unset')],...['none','minimal','low','medium','high','xhigh','max','ultra'].map(v=>[v,v])]),advancedFields(caller.advanced)],async values=>{
    const input={harness:values.get('harness'),...limits(values)};for(const key of ['model','reasoningEffort']){if(!values.get(key)&&callerExecution[key])throw new Error(t('已有默认值不能清空，请填写模型并选择思考强度。','Existing defaults cannot be cleared; enter a model and choose a reasoning effort.'));if(values.get(key))input[key]=values.get(key);}
    callerExecution=(await call('caller_settings',input)).execution;say(t('使用端设置已保存','Client settings saved'));
  });
  callerForm.elements.harness.addEventListener('change',event=>perform(async()=>{const harness=event.target.value;const result=await call('caller_settings',{harness});if(callerForm.elements.harness.value!==harness)return;callerExecution=result.execution;callerForm.elements.model.value=result.execution.model || '';callerForm.elements.reasoningEffort.value=result.execution.reasoningEffort || '';}));
  mount.replaceChildren(el('section',{class:'setting'},el('div',{class:'sectionhead'},el('h2',{},t('网页管理','Web management')),btn(t('关闭','Disable'),()=>confirmation(t('关闭网页管理','Disable web management'),t('只停止本机管理入口，独立共享继续。之后在原对话中说“打开管理页”即可重新启用。','Stops this local management entry; independent sharing continues. Ask to open management in the original conversation to enable it again.'),async()=>{await call('web_management',{enabled:false});state.stopped=true;clearTimeout(poll);app.replaceChildren(el('main',{},el('h1',{},t('网页管理已关闭','Web management disabled')),el('p',{class:'info'},t('可在原对话中重新打开。独立共享不受影响。','Reopen it from the original conversation. Independent sharing is unaffected.'))));}))),el('p',{},t('仅本机访问，随当前宿主退出而关闭。','Local access only; closes when its managing app exits.'))),
    el('section',{class:'setting'},el('h2',{},t('使用端默认值','Client defaults')),el('p',{},t('只影响新任务，模型需由目标节点提供。','New tasks only; the destination must offer the selected model.')),callerForm),
    el('section',{class:'setting'},el('h2',{},t('我共享的','Resources I share')),form([check(t('保留委托会话在任务列表中','Keep delegated sessions in the task list'),'keepSessionVisible',provider.keepSessionVisible),el('p',{class:'sub'},t('仅支持 Codex。默认关闭：执行期间可能出现，每轮结束后归档，续作前恢复。开启后保留在普通列表，仅用于查看。只影响新建任务，不改变文件保留期；Claude 保持原行为。','Codex only. Off by default: sessions may appear while running, archive after each turn, and restore before continuing. On keeps sessions in the regular list for viewing. New tasks only; file retention is unchanged. Claude is unaffected.')),field(t('节点并发上限','Concurrent task limit'),'maxConcurrent',provider.maxConcurrent,'number'),el('p',{class:'sub'},t('满额不排队；调低上限不打断已有任务。','No queue when full; lowering the limit does not interrupt active tasks.')),field(t('执行工具','Execution tool'),'harness',provider.harness,'select',[['codex','Codex'],['claude','Claude Code']]),check(t('开放全部可用模型，包含以后新增的模型','Offer all available models, including future additions'),'all',provider.allowedModels==='all'),field(t('指定模型，每行一个；开放全部时忽略','Specific models, one per line; ignored when all are offered'),'models',Array.isArray(provider.allowedModels)?provider.allowedModels.join('\n'):'','textarea'),advancedFields(provider.advanced,true)],async values=>{
      const input={harness:values.get('harness'),...limits(values)};if(values.has('all'))input.allModels=true;else input.allowedModels=String(values.get('models')).split('\n').map(v=>v.trim()).filter(Boolean);
      input.maxConcurrent=Number(values.get('maxConcurrent'));input.keepSessionVisible=values.has('keepSessionVisible');await call('provider_settings',input);guide.settings.provider.keepSessionVisible=input.keepSessionVisible;guide.settings.provider.allowedModels[input.harness]=input.allModels?'all':input.allowedModels;state.quotas.delete('$local');say(input.harness==='claude'?t('设置已保存；Claude 暂不支持会话展示管理，保持原行为。','Settings saved; Claude session visibility is unsupported and unchanged.'):t('共享端设置已保存，仅影响新建任务','Host settings saved for new tasks'));
    })),el('section',{class:'setting'},el('h2',{},t('首次使用设置','First-use settings')),btn(t('查看并确认','Review settings'),async()=>showOnboarding(await call('onboarding')))));
  mount.prepend(el('section',{class:'setting'},el('h2',{},t('设备名称','Device name')),el('p',{},t('sub2sub 显示名；对端下次连接时更新，手动别名不变。','sub2sub display name; updates on next contact. Explicit aliases stay unchanged.')),form([field(t('本机显示名','Device display name'),'name',guide.settings.deviceName)],async values=>{const saved=await call('device_settings',{name:values.get('name')});if(state.data)state.data.device=saved.deviceName;await settings();say(t('设备名称已保存','Device name saved'));})));
  mount.append(el('section',{class:'setting'},el('h2',{},t('跨网络连接','Cross-network connections')),el('p',{},t('默认关闭，双方开启后可连接异地设备。优先私网直连；公共发现与中继可能影响隐私、速度和可用性。关闭前完成或明确取消跨网任务及传输。文件授权与任务联网权限不变。','Off by default; enable on both devices for cross-network access. Private connections come first. Public discovery and relays may affect privacy, speed and availability. Finish or explicitly cancel cross-network tasks and transfers before disabling. File consent and task network permissions are unchanged.')),form([check(t('开启跨网络连接服务','Enable cross-network service'),'crossNetwork',guide.settings.crossNetwork.enabled)],async values=>{try{await call('device_settings',{crossNetwork:values.has('crossNetwork')});}catch(error){const actual=await call('device_settings',{});mount.querySelector('[name=crossNetwork]').checked=actual.crossNetwork.enabled;throw error;}await settings();say(t('跨网络连接设置已保存','Cross-network setting saved'));})));
  mount.append(el('section',{class:'setting'},el('h2',{},t('本地空间','Local storage')),el('p',{},t('手动清理前会预览范围。','Preview the scope before manual cleanup.')),btn(t('查看空间占用','Inspect storage'),storage)));
  const providerForm=[...mount.querySelectorAll('form')].find(node=>node.elements.keepSessionVisible);
  providerForm.elements.harness.addEventListener('change',()=>{
    const allowed=guide.settings.provider.allowedModels[providerForm.elements.harness.value];
    providerForm.elements.all.checked=allowed==='all';providerForm.elements.models.value=Array.isArray(allowed)?allowed.join('\n'):'';
  });

}
function showOnboarding(data) {
  const s=data.settings;
  const limitValue=(v,unit)=>v==null?t('不限量','Unlimited'):`${(unit==='MiB'?v/1048576:v).toLocaleString(language)} ${unit}`;
  const limitText=v=>`${t('输入','Input')}: ${limitValue(v.inputBytes,'MiB')} / ${limitValue(v.inputFiles,t('个文件','files'))}\n${t('返回','Result')}: ${limitValue(v.resultBytes,'MiB')} / ${limitValue(v.resultFiles,t('个文件','files'))}`;
  const rows=[
    [t('设备','Device'),s.deviceName],
    [t('跨网络连接','Cross-network connections'),s.crossNetwork.enabled?t('已开启；双方均需主动开启','On; both devices must opt in'):t('已关闭；默认关闭，确认设置不会开启','Off by default; confirming settings leaves it off')],
    [t('使用端默认值','Client defaults'),Object.entries(s.caller.execution).map(([tool,v])=>`${tool}: ${v.model ?? t('未设置','Unset')} / ${v.reasoningEffort ?? t('未设置','Unset')}`).join('\n')],
    [t('使用端传输上限','Client transfer limits'),limitText(s.caller.limits)],
    [t('共享端','Host'),`${s.provider.harness}\n${Object.entries(s.provider.allowedModels).map(([tool,v])=>`${tool}: ${v==='all'?t('全部可用模型','All available models'):v.join(', ')}`).join('\n')}`],
    [t('保留 Codex 委托会话','Keep delegated Codex sessions'),s.provider.keepSessionVisible?t('开启；只影响新任务','On; new tasks only'):t('关闭；每轮结束后归档','Off; archive after each turn')],
    [t('节点并发上限','Concurrent task limit'),String(s.provider.maxConcurrent)],
    [t('共享端传输上限与保留期限','Host limits and retention'),`${limitText(s.provider.limits)}\n${s.provider.retentionDays} ${t('天','days')}`],
    [t('配置与数据位置','Configuration and data'),`${s.advanced.configPath}\n${s.advanced.stateRoot}`],
    [t('执行工具位置','Execution tool paths'),Object.entries(s.advanced.executionPaths).map(([tool,v])=>`${tool}: ${v}`).join('\n')],
    [t('最大可设传输上限','Maximum configurable transfer limits'),`${limitValue(s.advanced.supportedLimits.bytes,'MiB')} / ${limitValue(s.advanced.supportedLimits.files,t('个文件','files'))}`],
    [t('连接及文件授权','Connections and file consent'),data.connections.map(peer=>`${peer.displayName || peer.name} · ${peer.host || peer.taskRoot || peer.transport}${peer.port?':'+peer.port:''} · ${peer.transferAuthorization.scope==='task-files'?t('允许任务文件','Task files allowed'):t('未授权','Not authorized')} · ${t('连接尚未检查','Connection unchecked')}`).join('\n') || t('暂无连接','No connections')],
    [t('已授权使用端','Authorized clients'),data.pairings.map(peer=>`${peer.name} · ${peer.pairId}`).join('\n') || t('暂无使用端','No clients')],
    [t('本机共享与监听地址','Sharing and listen address'),`${labelStatus(data.sharing.status)} · ${s.provider.network.address==='auto-select'?t('自动选择地址','Automatic address'):s.provider.network.address}:${s.provider.network.port}`]
  ];
  showDialog(t('确认首次使用设置','Review first-use settings'),el('div',{},data.confirmationRequired?el('div',{class:'intro'},el('h3',{},t('先了解怎么用','How it works')),el('p',{},t('接收任务的电脑生成邀请；发起任务的电脑连接并确认文件授权。随后在原对话中委托任务、打开本地成果、继续修改。','The receiving computer creates an invitation. Connect and approve file transfer on the sending computer, then delegate, open local results and request revisions in your conversation.'))):null,el('p',{class:'info'},t('模型可用性尚未查询；“全部模型”包含以后新增的可用模型。保留期清理仍要求成果已保存且无执行中的任务。设置确认不代表文件传输授权。','Model availability is unverified; all models includes future available models. Retention cleanup requires saved results and no active work. Settings confirmation does not authorize file transfer.')),el('dl',{},rows.flatMap(([a,b])=>[el('dt',{},a),el('dd',{class:'info'},b)])),btn(t('确认这些设置','Confirm these settings'),async()=>{await call('onboarding',{action:'confirm'});dialog.close();say(t('设置已确认，可继续原操作。','Settings confirmed; continue your previous action.'));},'button primary')));
}
function example(zh,en) {
  const text=t(zh,en);
  return el('div',{class:'example'},el('p',{},text),btn(t('复制','Copy'),async()=>{await navigator.clipboard.writeText(text);say(t('已复制，可粘贴到原对话。','Copied. Paste into your conversation.'));},'link'));
}
function help() {
  state.page='help';render();
  document.getElementById('help').append(
    el('section',{},el('h2',{},t('从这里开始','Getting started')),el('p',{},t('两台电脑都安装 sub2sub。任务指令和追问留在 Codex / Claude Code 对话中。','Install sub2sub on both computers. Give task instructions and follow-ups in your Codex / Claude Code conversation.')),
      el('p',{},t('不同网络的设备，先在双方开启跨网络连接服务；默认关闭。','For devices on different networks, first enable cross-network service on both; it is off by default.')),
      el('ol',{class:'steps'},
        el('li',{},el('h3',{},t('接收方生成邀请','Create an invitation on the receiver')),example('生成 sub2sub 邀请码。','Generate a sub2sub invitation.'),el('p',{},t('这会开启接收方共享，保持该电脑唤醒并联网。','This starts sharing on the receiver. Keep it awake and connected.'))),
        el('li',{},el('h3',{},t('发起方连接','Connect from the sender')),example('连接这个 sub2sub 邀请码，叫作「工作电脑」。','Connect this sub2sub invitation and name it work-computer.'),el('p',{},t('按提示确认文件传输范围。','Review the requested file-transfer scope.'))),
        el('li',{},el('h3',{},t('委托并打开本地成果','Delegate and open the local results')),example('用 sub2sub 只把 notes.txt 交给「工作电脑」，整理为 summary.md 并取回成果。','Use sub2sub to send only notes.txt to work-computer, summarize it in summary.md and collect the results.'),el('p',{},t('先准备一个不含敏感内容的短文本文件；答复和文件保存到本机后再查看。','Prepare a short, non-sensitive text file first. Open the answer and files once saved locally.'))),
        el('li',{},el('h3',{},t('在原任务上继续','Continue the same task')),example('继续这个任务，把总结再精简一点，并保存最新成果。','Continue that task. Shorten the summary and save the updated results.')))),
    el('section',{},el('h2',{},t('遇到问题','Troubleshooting')),example('帮我排查 sub2sub 的这个问题，先查询状态，不重新执行任务。','Help diagnose this sub2sub problem. Check its status without rerunning the task.'),el('p',{},t('需要反馈时，在原对话说“把这个问题提交到 GitHub”，先核对公开草稿。','To report it, ask in your conversation to submit the issue to GitHub, then review the public draft.')),
      el('a',{href:'https://github.com/mekoand/sub2sub/issues',target:'_blank',rel:'noopener noreferrer'},t('查看问题记录 ↗','Browse issues ↗'))),
    el('section',{},el('h2',{},t('关于 sub2sub','About sub2sub')),el('p',{},t('项目开源。欢迎到 GitHub 关注更新，或点一个 Star 支持项目。','sub2sub is open source. Follow updates on GitHub or leave a star to support the project.'))));
}

function render() {
  document.documentElement.lang=language;
  const head=el('header',{},el('div',{class:'brand'},'sub',el('span',{},'2'),'sub'),el('nav',{},el('button',{class:'nav',type:'button',...(state.page==='overview'?{'aria-current':'page'}:{}),onclick:()=>perform(async()=>{state.page='overview';await refresh();})},t('总览','Overview')),el('button',{class:'nav',type:'button',...(state.page==='settings'?{'aria-current':'page'}:{}),onclick:()=>perform(settings)},t('设置','Settings')),select([['zh','中文'],['en','EN']],language,event=>perform(async()=>{language=event.target.value;if(state.page==='settings')await settings();else if(state.page==='help')help();else render();}),{class:'language','aria-label':t('语言','Language')})));
  const main=el('main',{},el('div',{class:'pagehead'},el('div',{},el('h1',{},state.page==='settings'?t('设置','Settings'):state.page==='help'?t('使用帮助','Help'):t('总览','Overview')),el('p',{},state.data?.device || 'sub2sub')),state.page==='overview'?btn(t('刷新状态','Refresh status'),()=>refresh(true)):null));
  if(state.page==='settings')main.append(el('div',{id:'settings',class:'settings'}));
  else if(state.page==='help')main.append(el('div',{id:'help',class:'help'}));
  else if(state.data)main.append(...[resources(),el('section',{class:'section'},el('div',{class:'sectionhead'},el('h2',{},t('最近任务','Recent tasks'))),state.data.tasks.length?state.data.tasks.map(taskSummary):el('p',{class:'empty'},t('还没有任务记录。','No task records yet.'))),usageView(state.data.statistics)].filter(Boolean));
  else main.append(el('p',{class:'empty'},t('正在读取本机记录…','Reading local records…')));
  main.append(el('footer',{},btn(t('使用帮助','Help'),help,'link'),el('a',{href:'https://github.com/mekoand/sub2sub',target:'_blank',rel:'noopener noreferrer',class:'link'},'GitHub · Star ↗')));
  app.replaceChildren(head,main);
}
async function refresh(check=false) {
  if(state.stopped)return;
  if(state.refresh){state.refreshQueued=true;return;}
  state.refresh=true;
  try {
    const role=state.role, days=state.days;
    const data=await api(`/api/overview?role=${role}&days=${days}&check=${check}`);
    if(role!==state.role || days!==state.days)return;
    if(role==='caller')data.peers=data.peers.map(peer=>{
      if(check)state.peerChecks.set(peer.name,{...peer,checkedAt:new Date().toISOString()});
      const saved=state.peerChecks.get(peer.name);
      return saved?{...peer,status:saved.status,harness:saved.harness,reason:saved.reason,checkedAt:saved.checkedAt,occupiedSlots:saved.occupiedSlots,maxConcurrent:saved.maxConcurrent,connection:saved.connection}:peer;
    });
    if(check)state.quotas.clear();
    state.data=data;
    if(state.page==='overview')render();
  } finally { state.refresh=false; if(state.refreshQueued){state.refreshQueued=false;void perform(()=>refresh());}else schedule(); }
}
function schedule() {
  clearTimeout(poll);
  if(!document.hidden&&!state.stopped&&state.page==='overview')poll=setTimeout(()=>perform(()=>refresh()),30000);
}
document.addEventListener('visibilitychange',()=>{clearTimeout(poll);if(!document.hidden)perform(()=>refresh());});
if(!token)app.append(el('main',{},el('h1',{},'sub2sub'),el('p',{class:'info'},t('请在原对话中说“打开 sub2sub 管理页”，使用返回的本机私密链接。','Ask to open sub2sub management in your conversation and use the returned private local link.'))));
else {render();perform(()=>refresh());}
