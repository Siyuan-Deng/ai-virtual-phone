"use client";

// 自定义状态栏渲染画布：用户在聊天信息页写的「输出渲染」HTML 在沙盒 iframe 里执行，
// AI 的 [状态栏] 壳内原文通过 window.STATUS_RAW（JS 取用）与 {{RAW}}（模板直插，已转义）注入。
// 高度自适应桥与剧场画布同款；allow-scripts 无 same-origin，碰不到宿主页面与数据。

import { useEffect, useMemo, useRef, useState } from "react";

const FRAME_MIN_HEIGHT = 36;

function escapeHtmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSrcDoc(html: string, raw: string, frameId: string): string {
    const withRaw = html.split("{{RAW}}").join(escapeHtmlText(raw));
    const base = /<html[\s>]/i.test(withRaw)
        ? withRaw
        : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${withRaw}</body></html>`;
    const inject = `<script>window.STATUS_RAW=${JSON.stringify(raw)};</` + `script>`;
    return /<head[\s>]/i.test(base)
        ? base.replace(/<head([^>]*)>/i, `<head$1>${inject}`)
        : inject + base;
}

export function CustomStatusFrame({ html, raw }: { html: string; raw: string }) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameId] = useState(() => `csf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [height, setHeight] = useState(FRAME_MIN_HEIGHT);

    const srcDoc = useMemo(() => {
        const doc = buildSrcDoc(html, raw, frameId);
        const bridge = `<script>(function(){
  var frameId=${JSON.stringify(frameId)};
  // 从文档顶上量到最低那块的下外边距：整页 HTML 的 body 默认 8px 外边距、外框自带的 margin 都算进来，不然底下会被裁掉一截
  function mb(el){return parseFloat(getComputedStyle(el).marginBottom)||0;}
  function measure(){var b=document.body;if(!b)return ${FRAME_MIN_HEIGHT};var y=window.scrollY||0;var h=b.getBoundingClientRect().bottom+y+mb(b);
    for(var i=0;i<b.children.length;i++){var el=b.children[i];var c=el.getBoundingClientRect();if(c.width||c.height)h=Math.max(h,c.bottom+y+mb(el));}
    return Math.max(Math.ceil(h),${FRAME_MIN_HEIGHT});}
  function send(){parent.postMessage({source:'chat-status-frame',type:'resize',id:frameId,height:measure()},'*');}
  function sched(){requestAnimationFrame(function(){send();requestAnimationFrame(send);});}
  window.addEventListener('load',sched);window.addEventListener('resize',sched);
  // 聊天截图要用：外面读不到沙盒里的 DOM，问到了就把当下画好的 HTML 交出去
  window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='chat-status-frame'||d.type!=='snapshot')return;
    parent.postMessage({source:'chat-status-frame',type:'snapshot',id:frameId,html:document.documentElement.outerHTML},'*');});
  if(window.MutationObserver)new MutationObserver(sched).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});
  setTimeout(send,60);setTimeout(send,400);
})();</` + `script>`;
        return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${bridge}</body>`) : doc + bridge;
    }, [html, raw, frameId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.source !== "chat-status-frame" || data.type !== "resize" || data.id !== frameId) return;
            const next = Number(data.height);
            if (Number.isFinite(next)) setHeight(Math.min(Math.max(next, FRAME_MIN_HEIGHT), 1200));
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, [frameId]);

    return (
        <iframe
            ref={iframeRef}
            title="自定义状态栏"
            sandbox="allow-scripts"
            scrolling="no"
            srcDoc={srcDoc}
            style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
        />
    );
}
