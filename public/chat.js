const $=s=>document.querySelector(s);
let me=null,friends=[],active=null,socket=null,oneTime=false,typingTimer=null;

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
 const wrap=document.createElement("div");wrap.className=`bubble-row ${m.mine?"mine":""}`;wrap.dataset.message=m.id;
 let body="";
 if(m.deletedAt)body="<p class='deleted'>Message deleted</p>";
 else if(m.type==="text"){
   if(m.oneTime&&!m.mine){
     body=m.viewedAt?`<p class="once-done">One-time message opened</p>`:`<button class="media-once text-once" data-once-text="${m.id}">✉<br><small>Tap to read once</small></button>`;
   }else body=`<p>${esc(m.text)}</p>`;
   if(m.oneTime)body+=`<span class="one-label">1× ${m.viewedAt?"opened":"view once"}</span>`;
 }else{
   const expired=m.oneTime&&m.viewedAt&&!m.mine;
   if(expired)body=`<p>One-time media opened</p>`;
   else if(m.type==="image")body=m.oneTime&&!m.mine?`<button class="media-once" data-once-id="${m.id}">▣<br><small>Tap to open image once</small></button>`:`<img class="media" src="${esc(m.mediaUrl)}" alt="image">`;
   else body=m.oneTime&&!m.mine?`<button class="media-once" data-once-id="${m.id}">▶<br><small>Tap to open video once</small></button>`:`<video class="media" controls playsinline preload="metadata" src="${esc(m.mediaUrl)}"></video>`;
   if(m.oneTime)body+=`<span class="one-label">1× ${m.viewedAt?"opened":"view once"}</span>`;
 }
 const status=m.mine?(m.oneTime&&m.viewedAt?"Opened":m.readAt?"Read":m.deliveredAt?"Delivered":"Sent"):"";
 wrap.innerHTML=`<div class="bubble">${body}<div class="meta"><span>${time(m.createdAt)}</span>${status?`<span>${status}</span>`:""}</div></div>`;
 $("#messages").appendChild(wrap);

 // read receipts: only when the tab is visible; one-time items count as read once opened
 if(!m.mine&&m.senderId===active?.id&&!m.readAt&&!m.oneTime&&!m.deletedAt){
   if(document.hidden)wrap.dataset.unread="1";else markRead(m.id);
 }

 const once=wrap.querySelector("[data-once-id]");
 if(once) once.addEventListener("click",async()=>{
   if(once.dataset.busy)return; once.dataset.busy="1";
   try{
     const r=await fetch(`/api/media-once/${encodeURIComponent(m.id)}`);
     if(!r.ok)throw new Error(r.status===410?"This one-time item was already opened.":"Could not open media.");
     const blob=await r.blob(), url=URL.createObjectURL(blob);
     if(m.type==="image") once.outerHTML=`<img class="media" src="${url}" alt="image">`;
     else once.outerHTML=`<video class="media" controls autoplay playsinline src="${url}"></video>`;
     const label=wrap.querySelector(".one-label");if(label)label.textContent="1× opened";
   }catch(e){once.dataset.busy="";toast(e.message)}
 });

 const onceText=wrap.querySelector("[data-once-text]");
 if(onceText) onceText.addEventListener("click",async()=>{
   if(onceText.dataset.busy)return; onceText.dataset.busy="1";
   try{
     const d=await api(`/api/messages/${encodeURIComponent(m.id)}/open-once`,{method:"POST"});
     const p=document.createElement("p");p.textContent=d.text;onceText.replaceWith(p);
     const label=wrap.querySelector(".one-label");if(label)label.textContent="1× opened";
   }catch(e){onceText.dataset.busy="";if(e.message!=="AUTH")toast(e.message)}
 });
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
