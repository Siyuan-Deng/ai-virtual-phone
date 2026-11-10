// 开屏第一帧的底色。页面一出来、代码还没跑完的时候，开屏那块是浅色的，要等代码跑完、原图从数据库读出来才画上；
// 换成深色开屏的人一打开就先闪一下白，晚上很刺眼。
// 下面这段脚本放在 <head> 里，第一帧之前就跑：照着 App 的规则先挑好这次放哪一套（App 之后直接用它挑的），
// 再把底色铺成那一套的颜色——有图的用原图的平均色（正常打开一次时算好存下），没图的用它自己的背景色。
// float 原版本来就是浅色，不动。只读 localStorage：这时候 IndexedDB 还没打开。

/** 开屏库在 localStorage 的那份（splash-store） */
export const SPLASH_MIRROR_KEY = "ai_phone_splash_library_mirror_v1";
/** 上一次放的哪套，随机时尽量不连着两次一样（splash-store） */
export const SPLASH_LAST_PICK_KEY = "ai_phone_splash_last_pick_v1";
/** 原图素材 id → 平均色 */
export const SPLASH_TONE_KEY = "ai_phone_splash_image_tone_v1";
/** 夜间模式状态在 localStorage 的那份（night-mode） */
export const NIGHT_STATE_MIRROR_KEY = "ai_phone_night_mode_mirror_v1";
/** 脚本挑好的那套开屏 id 放在 window 的这个名字下；"" = 池子是空的 */
export const SPLASH_BOOT_PICK_GLOBAL = "__floatSplashBootPick";

// 挑哪套和 splash-store 的 splashBootPlan、night-mode 的 lookSetAtBoot 是同一套规则，改那边要一起改这里
export const SPLASH_FIRST_PAINT_SCRIPT = `(function(){try{
var ls=window.localStorage,lib=JSON.parse(ls.getItem(${JSON.stringify(SPLASH_MIRROR_KEY)})||"null");
if(!lib||!Array.isArray(lib.splashes))return;
var st=JSON.parse(ls.getItem(${JSON.stringify(NIGHT_STATE_MIRROR_KEY)})||"{}"),set=typeof st.active==="string"?st.active:"day",now=new Date();
if(st.auto==="time"&&Array.isArray(st.points)&&st.points.length){
if(!(typeof st.manualUntil==="number"&&now.getTime()<st.manualUntil)){
var mins=function(t){var p=String(t).split(":");return Number(p[0])*60+Number(p[1]);};
var m=now.getHours()*60+now.getMinutes(),pts=st.points.slice().sort(function(a,b){return mins(a.time)-mins(b.time);}),cur=pts[pts.length-1].set;
pts.forEach(function(p){if(mins(p.time)<=m)cur=p.set;});set=cur;}
}else if(st.auto==="system"&&typeof window.matchMedia==="function"){
var dq=window.matchMedia("(prefers-color-scheme: dark)"),dark=dq.media==="not all"?null:dq.matches?true:window.matchMedia("(prefers-color-scheme: light)").matches?false:null;
if(dark!==null&&st.manualSystemDark!==dark)set=(dark?st.systemDark:st.systemLight)||set;}
var pools=lib.pools||{},ids=(pools[set]||pools.day||[]).filter(function(id){return id==="float"?lib.floatRemoved!==true:lib.splashes.some(function(s){return s&&s.id===id;});});
var last=ls.getItem(${JSON.stringify(SPLASH_LAST_PICK_KEY)}),choices=ids.length>1?ids.filter(function(id){return id!==last;}):ids,pick=choices[Math.floor(Math.random()*choices.length)]||"";
window[${JSON.stringify(SPLASH_BOOT_PICK_GLOBAL)}]=pick;
var sp=lib.splashes.filter(function(s){return s&&s.id===pick;})[0];if(!sp)return;
var tones=JSON.parse(ls.getItem(${JSON.stringify(SPLASH_TONE_KEY)})||"{}"),color=(sp.imageAssetId&&tones[sp.imageAssetId])||sp.bgColor;
if(typeof color!=="string"||!color)return;
var root=document.documentElement;root.style.setProperty("--splash-boot-bg",color);root.setAttribute("data-splash-boot","");
}catch(e){}})();`;
