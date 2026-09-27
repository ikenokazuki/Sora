// Read-only feasibility probe; no post contents or account identifiers retained.
const url = 'wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post&kinds=commit';
const startedAt = new Date().toISOString(), t = performance.now();
const result = await new Promise(resolve => {
  let settled = false, opened = false, commits = 0, messages = 0, latestTime, firstEventMs;
  const operations = {create:0,update:0,delete:0};
  const ws = new WebSocket(url, ['xrpc.v1.json']);
  const finish = (status) => {
    if(settled) return;
    settled = true; clearTimeout(timer); ws.close();
    resolve({environment:process.argv[2] ?? 'host',url,startedAt,finishedAt:new Date().toISOString(),status,opened,messages,commits,operations,firstEventMs,latestTime,durationMs:Math.round(performance.now()-t)});
  };
  const timer=setTimeout(()=>finish('timeout'),12000);
  ws.onopen=()=>{opened=true;};
  ws.onmessage=e=>{
    messages++;
    try{
      const data=JSON.parse(String(e.data)), event=data.payload;
      if (event?.collection==='app.bsky.feed.post' && event?.operation) {
        commits++; if(event.operation in operations)operations[event.operation]++; latestTime=event.time; firstEventMs ??= Math.round(performance.now()-t);
        if(commits>=5)finish('received_live_records');
      }
    }catch{}
  };
  ws.onerror=()=>finish('connection_error');
  ws.onclose=()=>finish('closed');
});
console.log(JSON.stringify(result,null,2));
