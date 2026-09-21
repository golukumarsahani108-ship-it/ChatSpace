const $=s=>document.querySelector(s);
let me=null,friends=[],active=null,socket=null,oneTime=false,typingTimer=null;
let selectedMessages=new Set();
let contextMenu=null;
let longPressTimer=null;
let actionStylesReady=false;

async function api(url,opt={}){const r=await fetch(url,{credentials:"same-origin",...opt});let d={};try{d=await r.json()}catch{}if(r.status===401){location.href="/";throw new Error("AUTH")}if(!r.ok)throw new Error(d.message||d.error||"Request failed");return d}
function esc(s){const d=document.createElement("div");d.textContent=s??"";return d.innerHTML}
function avatar(u,cls="avatar"){return `<div class="${cls}">${u?.avatarUrl?`<img src="${esc(u.avatarUrl)}">`:esc((u?.displayName||u?.username||"?")[0].toUpperCase())}</div>`}
function toast(t){const x=$("#toast");x.textContent=t;x.classList.add("show");clearTimeout(x._t);x._t=setTimeout(()=>x.classList.remove("show"),2600)}
function time(t){return new Date(t).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}

/* ---------------- Notifications (enabled in Settings) ---------------- */
function notifyEnabled(){return "Notification" in window&&Notification.permission==="granted"&&localStorage.getItem("cs_notify")==="1"}
function showNotification(m){
 if(!notifyEnabled())return;
 const sender=friends.find(f=>f.id===m.senderId);
 const title=sender?.displayName||m.senderName||"ChatSpace";
 let body;
 if(m.type==="image")body=m.oneTime?"🔒 One-time photo":"📷 Photo";
 else if(m.type==="video")body=m.oneTime?"🔒 One-time video":"🎬 Video";
 else body=m.oneTime?"🔒 Sent you a one-time message":(m.text||"New message");
 const opts={body:body.slice(0,140),icon:"/icon-192.png",badge:"/favicon-64.png",tag:`msg-${m.senderId}`,renotify:true,data:{url:"/chat.html"}};
 const fallback=()=>{try{new Notification(title,opts)}catch{}};
 if(navigator.serviceWorker?.ready)navigator.serviceWorker.ready.then(r=>r.showNotification(title,opts)).catch(fallback);else fallback();
}

/* ---------------- Init / friends ---------------- */
async function init(){
 try{
  const m=await api("/api/me");me=m.user;renderMe();
  await loadFriends(); connectSocket();
  // phones: no chat open yet, so show the friends list instead of an empty screen
  if(innerWidth<=800&&!active)document.querySelector(".app-shell").classList.add("show-sidebar");
 }catch(e){if(e.message!=="AUTH")toast(e.message)}
}
function renderMe(){ $("#meCard").innerHTML=`${avatar(me)}<div class="user-copy"><strong>${esc(me.displayName)}</strong><span>@${esc(me.username)}</span></div>`}
async function loadFriends(){
 const d=await api("/api/friends");friends=d.friends||[];renderFriends();
 if(d.incoming?.length) toast("You have a new friend request.");
}
function renderFriends(){
 const box=$("#friends");
 if(!friends.length){box.innerHTML=`<div class="help" style="padding:20px 6px">No friends yet.<br>Tap + to add someone by username.</div>`;return}
 box.innerHTML=friends.map(u=>`<div class="friend ${active?.id===u.id?"active":""}" data-id="${u.id}">
 ${avatar(u)}<div class="friend-info"><strong>${esc(u.displayName)}</strong><span>@${esc(u.username)} · ${u.online?"online":"offline"}</span></div><i class="presence ${u.online?"on":""}"></i></div>`).join("");
 box.querySelectorAll(".friend").forEach(x=>x.onclick=()=>openChat(x.dataset.id));
}
async function openChat(id){
 active=friends.find(x=>x.id===id);if(!active)return;
 toggleEmoji(false);
 document.body.querySelector(".app-shell").classList.remove("show-sidebar");
 $("#chatPerson").classList.remove("empty");
 $("#chatPerson").innerHTML=`${avatar(active,"avatar big")}<div><strong>${esc(active.displayName)}</strong><span>@${esc(active.username)} · <b id="personStatus">${active.online?"online":"offline"}</b></span></div>`;
 $("#composer").classList.remove("disabled");$("#textInput").disabled=false;$("#sendBtn").disabled=false;
 renderFriends();$("#messages").innerHTML="";
 const d=await api(`/api/conversations/${active.id}/messages`);
 d.messages.forEach(renderMessage);
 scrollBottom();
}
function connectSocket(){
 socket=io({withCredentials:true});
 socket.on("connect_error",()=>toast("Realtime connection unavailable."));
 socket.on("presence",p=>{
  const f=friends.find(x=>x.id===p.userId);if(f){f.online=p.online;f.lastSeen=p.lastSeen;renderFriends();if(active?.id===f.id)$("#personStatus").textContent=p.online?"online":"offline"}
 });
 socket.on("typing",p=>{if(active?.id===p.userId){$("#typing").textContent=p.typing?"typing…":""}});
 socket.on("friend:request",()=>{toast("New friend request received.");loadFriends()});
 socket.on("friend:updated",()=>loadFriends());
 socket.on("message:new",m=>{
  if(active?.id===m.senderId||active?.id===m.recipientId){renderMessage(m);scrollBottom()}
  else if(!m.mine)toast("New message received.");
  if(!m.mine&&document.hidden)showNotification(m);
 });
 socket.on("message:read",p=>updateMessageMeta(p.id,{readAt:p.readAt}));
 socket.on("message:viewed",p=>updateMessageMeta(p.id,{viewedAt:p.viewedAt}));
 socket.on("message:deleted",p=>{const el=document.querySelector(`[data-message="${p.id}"] .bubble`);if(el){el.classList.add("deleted");el.innerHTML="<p>Message deleted</p>"}});
}

/* ---------------- Messages ---------------- */
function renderMessage(m){
  ensureMessageActionStyles();
  rememberMessage(m);

  if(m.deletedForMe)return;

  const old=document.querySelector(`[data-message="${m.id}"]`);
  if(old)old.remove();

  const wrap=document.createElement("div");
  wrap.className=`bubble-row ${m.mine?"mine":""}`;
  wrap.dataset.message=m.id;

  let body="";

  if(m.deletedAt){
    body="<p class='deleted'>Message deleted for everyone</p>";
  }else if(m.type==="text"){
    if(m.oneTime&&!m.mine){
      body=m.viewedAt
        ? `<p class="once-done">One-time message opened</p>`
        : `<button class="media-once text-once" data-once-text="${m.id}">✉<br><small>Tap to read once</small></button>`;
    }else{
      body=`<p>${esc(m.text)}</p>`;
    }

    if(m.oneTime){
      body+=`<span class="one-label">1× ${m.viewedAt?"opened":"view once"}</span>`;
    }
  }else{
    const expired=m.oneTime&&m.viewedAt&&!m.mine;

    if(expired){
      body=`<p>One-time media opened</p>`;
    }else if(m.type==="image"){
      body=m.oneTime&&!m.mine
        ? `<button class="media-once" data-once-id="${m.id}">▣<br><small>Tap to open image once</small></button>`
        : `<img class="media" src="${esc(m.mediaUrl)}" alt="image">`;
    }else{
      body=m.oneTime&&!m.mine
        ? `<button class="media-once" data-once-id="${m.id}">▶<br><small>Tap to open video once</small></button>`
        : `<video class="media" controls playsinline preload="metadata" src="${esc(m.mediaUrl)}"></video>`;
    }

    if(m.oneTime){
      body+=`<span class="one-label">1× ${m.viewedAt?"opened":"view once"}</span>`;
    }
  }

  const status=m.mine
    ? (m.oneTime&&m.viewedAt
        ? "Opened"
        : m.readAt
          ? "Read"
          : m.deliveredAt
            ? "Delivered"
            : "Sent")
    : "";

  const forwardedLabel=m.forwarded
    ? `<div class="forwarded-label">↗ Forwarded</div>`
    : "";

  const selectionClass=selectedMessages.has(m.id)?" selected":"";

  wrap.innerHTML=`
    <div class="message-action-hit${selectionClass}" aria-label="Message actions">
      <div class="bubble">
        ${forwardedLabel}
        ${body}
        <div class="meta">
          <span>${time(m.createdAt)}</span>
          ${status?`<span>${status}</span>`:""}
        </div>
      </div>
    </div>
  `;

  $( "#messages" ).appendChild(wrap);

  const hit=wrap.querySelector(".message-action-hit");

  hit.addEventListener("contextmenu",e=>{
    e.preventDefault();
    openMessageMenu(m,e.clientX,e.clientY);
  });

  hit.addEventListener("pointerdown",e=>{
    if(e.pointerType!=="touch")return;

    clearTimeout(longPressTimer);

    longPressTimer=setTimeout(()=>{
      openMessageMenu(m,e.clientX,e.clientY);
    },550);
  });

  ["pointerup","pointercancel","pointerleave"].forEach(type=>{
    hit.addEventListener(type,()=>{
      clearTimeout(longPressTimer);
    });
  });

  // Double click / double tap = select.
  hit.addEventListener("dblclick",()=>{
    toggleMessageSelection(m.id);
  });

  hit.addEventListener("click",e=>{
    if(!document.body.classList.contains("message-selection-mode"))return;
    if(e.target.closest("button,a,video,img"))return;
    toggleMessageSelection(m.id);
  });

  // read receipts
  if(!m.mine&&m.senderId===active?.id&&!m.readAt&&!m.oneTime&&!m.deletedAt){
    if(document.hidden)wrap.dataset.unread="1";
    else markRead(m.id);
  }

  const once=wrap.querySelector("[data-once-id]");

  if(once) once.addEventListener("click",async e=>{
    e.stopPropagation();

    if(once.dataset.busy)return;
    once.dataset.busy="1";

    try{
      const r=await fetch(`/api/media-once/${encodeURIComponent(m.id)}`);

      if(!r.ok){
        throw new Error(
          r.status===410
            ?"This one-time item was already opened."
            :"Could not open media."
        );
      }

      const blob=await r.blob();
      const url=URL.createObjectURL(blob);

      if(m.type==="image"){
        once.outerHTML=`<img class="media" src="${url}" alt="image">`;
      }else{
        once.outerHTML=`<video class="media" controls autoplay playsinline src="${url}"></video>`;
      }

      const label=wrap.querySelector(".one-label");
      if(label)label.textContent="1× opened";
    }catch(e){
      once.dataset.busy="";
      toast(e.message);
    }
  });

  const onceText=wrap.querySelector("[data-once-text]");

  if(onceText) onceText.addEventListener("click",async e=>{
    e.stopPropagation();

    if(onceText.dataset.busy)return;
    onceText.dataset.busy="1";

    try{
      const d=await api(
        `/api/messages/${encodeURIComponent(m.id)}/open-once`,
        {method:"POST"}
      );

      const p=document.createElement("p");
      p.textContent=d.text;
      onceText.replaceWith(p);

      const label=wrap.querySelector(".one-label");
      if(label)label.textContent="1× opened";
    }catch(e){
      onceText.dataset.busy="";

      if(e.message!=="AUTH")toast(e.message);
    }
  });
}

function markMessageDeletedForEveryone(row){
  if(!row)return;

  selectedMessages.delete(row.dataset.message);
  row.classList.remove("selected");

  const hit=row.querySelector(".message-action-hit");
  if(!hit)return;

  hit.innerHTML=`
    <div class="bubble deleted-bubble">
      <p class="deleted">Message deleted for everyone</p>
      <div class="meta">
        <span>${time(new Date().toISOString())}</span>
      </div>
    </div>
  `;

  updateSelectionUI();
}

function markRead(id){socket?.emit("read",{messageId:id});api(`/api/messages/${id}/read`,{method:"POST"}).catch(()=>{})}
document.addEventListener("visibilitychange",()=>{
 if(document.hidden)return;
 document.querySelectorAll("[data-unread]").forEach(el=>{el.removeAttribute("data-unread");markRead(el.dataset.message)});
});
function updateMessageMeta(id,p){
 const row=document.querySelector(`[data-message="${id}"]`);if(!row)return;
 const spans=row.querySelectorAll(".meta span");
 if(p.viewedAt){if(spans[1])spans[1].textContent="Opened";const l=row.querySelector(".one-label");if(l)l.textContent="1× opened"}
 else if(p.readAt&&spans[1]&&spans[1].textContent!=="Opened")spans[1].textContent="Read";
}
function scrollBottom(){const x=$("#messages");x.scrollTop=x.scrollHeight}

async function sendText(){
 if(!active)return;const input=$("#textInput"),text=input.value.trim();if(!text)return;
 const ot=oneTime;input.value="";resize();toggleEmoji(false);
 try{await api("/api/messages/text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({recipientId:active.id,text,oneTime:ot})});}
 catch(e){toast(e.message)}
}
async function sendFile(file){
 if(!active||!file)return;
 if(file.size>30*1024*1024)return toast("Maximum file size is 30 MB.");
 const fd=new FormData();fd.append("file",file);fd.append("recipientId",active.id);fd.append("oneTime",oneTime);
 try{await api("/api/messages/media",{method:"POST",body:fd});toast("Media sent.");}
 catch(e){toast(e.message)}
}
function resize(){const x=$("#textInput");x.style.height="auto";x.style.height=Math.min(x.scrollHeight,130)+"px"}


/* ---------------- Message actions ---------------- */

function ensureMessageActionStyles(){
  if(actionStylesReady)return;
  actionStylesReady=true;

  const style=document.createElement("style");
  style.id="chatspace-message-actions-style";
  style.textContent=`
    .message-action-hit{
      position:relative;
      border-radius:22px;
      transition:transform .16s ease,filter .16s ease,outline .16s ease;
    }

    .message-action-hit.selected{
      outline:2px solid rgba(125,211,252,.85);
      filter:brightness(1.12);
      transform:scale(1.01);
    }

    .bubble .forwarded-label{
      font-size:11px;
      opacity:.72;
      margin-bottom:6px;
      font-weight:700;
      letter-spacing:.04em;
    }

    .deleted-bubble{
      opacity:.7;
    }

    .message-selection-bar{
      position:fixed;
      left:50%;
      bottom:22px;
      transform:translateX(-50%);
      z-index:9998;
      display:flex;
      align-items:center;
      gap:8px;
      padding:10px 12px;
      border:1px solid var(--panel-border);
      border-radius:18px;
      background:var(--selection-bg);
      color:var(--text);
      backdrop-filter:blur(18px);
      box-shadow:0 16px 50px rgba(0,0,0,.30);
    }

    .message-selection-bar button,
    .message-context-menu button{
      border:0;
      color:var(--text);
      background:var(--button-bg);
      padding:9px 12px;
      border-radius:12px;
      cursor:pointer;
      font:inherit;
    }

    .message-selection-bar button:hover,
    .message-context-menu button:hover{
      background:var(--menu-hover);
      color:var(--blue);
    }

    .message-context-menu .danger{
      color:var(--danger);
    }

    .message-selection-count{
      font-weight:800;
      padding:0 6px;
      white-space:nowrap;
    }

    .message-context-menu{
      position:fixed;
      z-index:10000;
      min-width:210px;
      padding:7px;
      display:flex;
      flex-direction:column;
      gap:4px;
      border:1px solid var(--menu-border);
      border-radius:16px;
      background:var(--menu-bg);
      color:var(--menu-text);
      backdrop-filter:blur(20px);
      box-shadow:0 20px 60px rgba(0,0,0,.30);
    }

    .message-context-menu button{
      text-align:left;
      background:transparent;
    }

    .message-context-menu .danger{
      color:#ffb4b4;
    }

    .message-context-menu .disabled{
      opacity:.45;
      pointer-events:none;
    }

    .message-selection-mode .bubble-row{
      cursor:pointer;
    }

    @media(max-width:700px){
      .message-selection-bar{
        left:10px;
        right:10px;
        bottom:12px;
        transform:none;
        justify-content:center;
        flex-wrap:wrap;
      }

      .message-context-menu{
        min-width:190px;
      }
    }
  `;

  document.head.appendChild(style);
}

function getMessageData(id){
  return window.__chatMessages?.find(m=>m.id===id)||null;
}

function rememberMessage(m){
  if(!window.__chatMessages)window.__chatMessages=[];
  const i=window.__chatMessages.findIndex(x=>x.id===m.id);

  if(i>=0)window.__chatMessages[i]=m;
  else window.__chatMessages.push(m);
}

function toggleMessageSelection(id){
  if(!id)return;

  closeMessageMenu();

  if(selectedMessages.has(id)){
    selectedMessages.delete(id);
  }else{
    selectedMessages.add(id);
  }

  const row=document.querySelector(`[data-message="${id}"]`);
  row?.classList.toggle("selected",selectedMessages.has(id));
  row?.querySelector(".message-action-hit")?.classList.toggle(
    "selected",
    selectedMessages.has(id)
  );

  document.body.classList.toggle(
    "message-selection-mode",
    selectedMessages.size>0
  );

  updateSelectionUI();
}

function clearMessageSelection(){
  selectedMessages.clear();

  document.querySelectorAll(".message-action-hit.selected")
    .forEach(x=>x.classList.remove("selected"));

  document.body.classList.remove("message-selection-mode");

  const bar=document.querySelector(".message-selection-bar");
  if(bar)bar.remove();

  closeMessageMenu();
}

function updateSelectionUI(){
  const count=selectedMessages.size;

  let bar=document.querySelector(".message-selection-bar");

  if(!count){
    if(bar)bar.remove();
    document.body.classList.remove("message-selection-mode");
    return;
  }

  document.body.classList.add("message-selection-mode");

  if(!bar){
    bar=document.createElement("div");
    bar.className="message-selection-bar";
    document.body.appendChild(bar);
  }

  const selected=[...selectedMessages]
    .map(getMessageData)
    .filter(Boolean);

  const canForward=selected.length>0 &&
    selected.every(m=>!m.oneTime&&!m.deletedAt);

  const canDeleteEveryone=selected.length>0 &&
    selected.every(m=>m.mine&&!m.deletedAt);

  bar.innerHTML=`
    <span class="message-selection-count">
      ${count} selected
    </span>

    <button type="button" data-action="forward"
      ${canForward?"":"disabled"}>
      ↗ Forward
    </button>

    <button type="button" data-action="delete-me">
      Delete for me
    </button>

    <button type="button" data-action="delete-everyone"
      ${canDeleteEveryone?"":"disabled"}>
      Delete for everyone
    </button>

    <button type="button" data-action="cancel">
      Cancel
    </button>
  `;

  bar.querySelector('[data-action="forward"]')
    ?.addEventListener("click",forwardSelected);

  bar.querySelector('[data-action="delete-me"]')
    ?.addEventListener("click",()=>deleteSelected("me"));

  bar.querySelector('[data-action="delete-everyone"]')
    ?.addEventListener("click",()=>deleteSelected("everyone"));

  bar.querySelector('[data-action="cancel"]')
    ?.addEventListener("click",clearMessageSelection);
}

function openMessageMenu(m,x,y){
  ensureMessageActionStyles();
  closeMessageMenu();

  const menu=document.createElement("div");
  menu.className="message-context-menu";
  contextMenu=menu;

  const canForward=!m.oneTime&&!m.deletedAt;
  const canDeleteEveryone=m.mine&&!m.deletedAt;

  menu.innerHTML=`
    <button type="button" data-action="select">✓ Select</button>
    <button type="button" data-action="forward"
      class="${canForward?"":"disabled"}">↗ Forward</button>
    <button type="button" data-action="delete-me">Delete for me</button>
    <button type="button" data-action="delete-everyone"
      class="${canDeleteEveryone?"":"disabled"}">
      Delete for everyone
    </button>
  `;

  document.body.appendChild(menu);

  const pad=10;
  const rect=menu.getBoundingClientRect();

  menu.style.left=`${Math.max(pad,Math.min(x,innerWidth-rect.width-pad))}px`;
  menu.style.top=`${Math.max(pad,Math.min(y,innerHeight-rect.height-pad))}px`;

  menu.querySelector('[data-action="select"]')
    .addEventListener("click",()=>toggleMessageSelection(m.id));

  menu.querySelector('[data-action="forward"]')
    .addEventListener("click",()=>{
      if(!canForward)return;
      selectedMessages.clear();
      selectedMessages.add(m.id);
      updateSelectionUI();
      forwardSelected();
    });

  menu.querySelector('[data-action="delete-me"]')
    .addEventListener("click",()=>{
      selectedMessages.clear();
      selectedMessages.add(m.id);
      deleteSelected("me");
    });

  menu.querySelector('[data-action="delete-everyone"]')
    .addEventListener("click",()=>{
      if(!canDeleteEveryone)return;
      selectedMessages.clear();
      selectedMessages.add(m.id);
      deleteSelected("everyone");
    });
}

function closeMessageMenu(){
  if(contextMenu){
    contextMenu.remove();
    contextMenu=null;
  }
}

document.addEventListener("pointerdown",e=>{
  if(contextMenu&&!e.target.closest(".message-context-menu")){
    closeMessageMenu();
  }
});

async function deleteOneMessage(id,mode){
  try{
    await api(
      `/api/messages/${encodeURIComponent(id)}/delete-${mode==="me"?"for-me":"for-everyone"}`,
      {method:"POST"}
    );

    if(mode==="me"){
      const row=document.querySelector(`[data-message="${id}"]`);
      if(row)row.remove();
    }else{
      const row=document.querySelector(`[data-message="${id}"]`);
      if(row)markMessageDeletedForEveryone(row);
    }

    selectedMessages.delete(id);
    updateSelectionUI();
  }catch(e){
    if(e.message!=="AUTH")toast(e.message);
  }
}

async function deleteSelected(mode){
  closeMessageMenu();

  const ids=[...selectedMessages];
  if(!ids.length)return;

  const title=mode==="me"
    ? `Delete ${ids.length} message${ids.length>1?"s":""} for you?`
    : `Delete ${ids.length} message${ids.length>1?"s":""} for everyone?`;

  if(!confirm(title))return;

  for(const id of ids){
    await deleteOneMessage(id,mode);
  }

  clearMessageSelection();
}

function forwardSelected(){
  closeMessageMenu();

  const ids=[...selectedMessages];
  if(!ids.length)return;

  const messages=ids
    .map(getMessageData)
    .filter(Boolean);

  if(messages.some(m=>m.oneTime||m.deletedAt)){
    toast("One-time or deleted messages cannot be forwarded.");
    return;
  }

  if(messages.length===1){
    openForwardFriendPicker(messages[0].id);
    return;
  }

  openForwardFriendPicker(ids);
}

function openForwardFriendPicker(messageIds){
  const ids=Array.isArray(messageIds)?messageIds:[messageIds];

  if(!friends.length){
    toast("You don't have any friends to forward to.");
    return;
  }

  const html=`
    <h2>Forward message${ids.length>1?"s":""}</h2>
    <p class="help">Choose a friend to receive ${ids.length>1?"these messages":"this message"}.</p>

    <div id="forwardFriends" style="
      display:flex;
      flex-direction:column;
      gap:8px;
      margin-top:16px;
      max-height:55vh;
      overflow:auto;
    ">
      ${friends.map(f=>`
        <button
          type="button"
          class="friend"
          data-forward-user="${esc(f.id)}"
          style="
            width:100%;
            display:flex;
            align-items:center;
            gap:10px;
            text-align:left;
            border:0;
            cursor:pointer;
          "
        >
          ${avatar(f)}
          <span class="friend-info">
            <strong>${esc(f.displayName)}</strong>
            <span>@${esc(f.username)}</span>
          </span>
        </button>
      `).join("")}
    </div>
  `;

  openModal(html);

  document.querySelectorAll("[data-forward-user]").forEach(btn=>{
    btn.addEventListener("click",async()=>{
      const recipientId=btn.dataset.forwardUser;

      btn.disabled=true;

      try{
        for(const id of ids){
          await api(
            `/api/messages/${encodeURIComponent(id)}/forward`,
            {
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({recipientId})
            }
          );
        }

        closeModal();
        clearMessageSelection();
        toast("Message forwarded.");
      }catch(e){
        btn.disabled=false;
        if(e.message!=="AUTH")toast(e.message);
      }
    });
  });
}

ensureMessageActionStyles();

/* ---------------- Emoji picker ---------------- */
const EMOJI_CATS=[
 ["😊","Smileys","😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 👽 👾 🤖 🎃"],
 ["👋","Gestures","👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🧠 👀 👁️ 👅 👄 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🤦 🤷 💃 🕺 🚶 🏃"],
 ["❤️","Hearts & sparks","❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ ⭐ 🌟 ⚡ 🔥 🌈 ☀️ ☁️ ❄️ 🎉 🎊 🎈 🎀 🎁 🏆 👑 💎"],
 ["🐶","Animals & nature","🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌲 🌳 🌴 🌵 🍀 🍁 🍂 🌙 🌍"],
 ["🍔","Food & drink","🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🍞 🧀 🍳 🥞 🥓 🍔 🍟 🍕 🌭 🌮 🌯 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍙 🍚 🍦 🍩 🍪 🎂 🍰 🍫 🍬 🍭 ☕ 🍵 🥤 🍺 🍻 🥂 🍷 🍹"],
 ["⚽","Activities","⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🎯 🎮 🕹️ 🎲 🎧 🎤 🎸 🎹 🎬 🎨 🥇 🥈 🥉 🏅 🎵 🎶"],
 ["🚀","Travel & objects","🚗 🚕 🚌 🏎️ 🚓 🚑 🚀 ✈️ 🚁 ⛵ 🚲 🏍️ 🏠 🏝️ 📱 💻 ⌚ 📷 🔒 🔑 💡 📚 ✏️ 💰 🔔 🔕 ✅ ❌ ❓ ❗ ✔️ ➕ ➖ ➡️ ⬅️"]
];
let emojiTab=0;
function recentEmoji(){try{return JSON.parse(localStorage.getItem("cs_recent_emoji")||"[]")}catch{return[]}}
function saveRecent(e){try{const r=[e,...recentEmoji().filter(x=>x!==e)].slice(0,24);localStorage.setItem("cs_recent_emoji",JSON.stringify(r))}catch{}}
function emojiTabs(){
 const r=recentEmoji(),tabs=[];
 if(r.length)tabs.push(["🕘","Recent",r]);
 EMOJI_CATS.forEach(([i,n,s])=>tabs.push([i,n,s.split(/\s+/).filter(Boolean)]));
 return tabs;
}
function renderEmojiPanel(){
 const tabs=emojiTabs();if(emojiTab>=tabs.length)emojiTab=0;
 const [,name,list]=tabs[emojiTab];
 $("#emojiPanel").innerHTML=`<div class="emoji-tabs">${tabs.map((t,i)=>`<button type="button" class="emoji-tab ${i===emojiTab?"active":""}" data-tab="${i}" title="${esc(t[1])}">${t[0]}</button>`).join("")}</div>
 <div class="emoji-title">${esc(name)}</div>
 <div class="emoji-grid">${list.map(e=>`<button type="button" class="emoji-item" data-emoji="${e}">${e}</button>`).join("")}</div>`;
}
function toggleEmoji(force){
 const panel=$("#emojiPanel"),open=force===undefined?panel.classList.contains("hidden"):force;
 if(open&&!active)return;
 panel.classList.toggle("hidden",!open);$("#emojiBtn").classList.toggle("active",open);
 if(open){emojiTab=0;renderEmojiPanel()}
}
function insertEmoji(e){
 const t=$("#textInput");if(t.disabled)return;
 const s=t.selectionStart??t.value.length,en=t.selectionEnd??s;
 t.value=t.value.slice(0,s)+e+t.value.slice(en);
 const pos=s+e.length;try{t.setSelectionRange(pos,pos)}catch{}
 t.dispatchEvent(new Event("input"));
 saveRecent(e);
}
$("#emojiBtn").onclick=()=>{if(!active)return toast("Choose a friend first.");toggleEmoji()};
$("#emojiPanel").addEventListener("mousedown",e=>{if(e.target.closest("button"))e.preventDefault()});
$("#emojiPanel").addEventListener("click",e=>{
 const tab=e.target.closest("[data-tab]");
 if(tab){emojiTab=Number(tab.dataset.tab);renderEmojiPanel();return}
 const it=e.target.closest("[data-emoji]");
 if(it)insertEmoji(it.dataset.emoji);
});
document.addEventListener("pointerdown",e=>{
 if(!$("#emojiPanel").classList.contains("hidden")&&!e.target.closest("#emojiPanel")&&!e.target.closest("#emojiBtn"))toggleEmoji(false);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape")toggleEmoji(false)});

/* ---------------- Friends modal ---------------- */
async function addFriend(){
 const d=await api("/api/friends");
 const incoming=d.incoming||[];
 const requestHtml=incoming.length?`<div style="margin-top:20px"><h3>Friend requests</h3>${incoming.map(r=>`
 <div class="friend" style="margin:8px 0;background:rgba(255,255,255,.03)">
 ${avatar(r.from)}<div class="friend-info"><strong>${esc(r.from.displayName)}</strong><span>@${esc(r.from.username)}</span></div>
 <button class="primary accept" data-rid="${r.id}" style="padding:7px 10px">Accept</button>
 </div>`).join("")}</div>`:"";
 openModal(`<h2>Add a friend</h2><p class="help">Search by their ChatSpace username. Email addresses stay private.</p>
 <div class="form-row"><label>USERNAME</label><input id="friendUsername" placeholder="@username" autocomplete="off"></div>
 <button class="primary" id="sendRequest">Send request</button>${requestHtml}`);
 $("#sendRequest").onclick=async()=>{try{await api("/api/friends/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("#friendUsername").value})});closeModal();toast("Friend request sent.");}catch(e){toast(e.message)}};
 document.querySelectorAll(".accept").forEach(b=>b.onclick=async()=>{try{await api("/api/friends/respond",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:b.dataset.rid,action:"accept"})});closeModal();await loadFriends();toast("Friend added.");}catch(e){toast(e.message)}});
}
function openModal(html){$("#modalContent").innerHTML=html;$("#modal").classList.remove("hidden")}
function closeModal(){$("#modal").classList.add("hidden")}

/* ---------------- Wiring ---------------- */
$("#attachBtn").onclick=()=>$("#fileInput").click();
$("#fileInput").onchange=e=>{const f=e.target.files[0];if(f)sendFile(f);e.target.value=""};
$("#oneTimeBtn").onclick=()=>{oneTime=!oneTime;$("#oneTimeBtn").classList.toggle("active",oneTime);toast(oneTime?"One-time mode ON":"One-time mode OFF")};
$("#sendBtn").onclick=sendText;
$("#textInput").addEventListener("input",()=>{resize();if(active){socket?.emit("typing",{recipientId:active.id,typing:true});clearTimeout(typingTimer);typingTimer=setTimeout(()=>socket?.emit("typing",{recipientId:active.id,typing:false}),900)}});
$("#textInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendText()}});
$("#addFriendBtn").onclick=addFriend;$("#profileBtn").onclick=()=>{location.href="/settings.html"};$("#closeModal").onclick=closeModal;
$("#modal").onclick=e=>{if(e.target.id==="modal")closeModal()};
// stopPropagation: the chat-panel click handler below would otherwise close the sidebar again immediately
$("#backBtn").onclick=e=>{e.stopPropagation();document.querySelector(".app-shell").classList.add("show-sidebar")};
$("#logoutBtn").onclick=async()=>{await api("/auth/logout",{method:"POST"}).catch(()=>{});location.href="/"};
document.querySelector(".chat-panel").addEventListener("click",()=>{if(innerWidth<=800)document.querySelector(".app-shell").classList.remove("show-sidebar")});
init();
