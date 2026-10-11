import net from 'node:net';

const SAFE_CODES=new Set(['AUTH_SERVICE_UNAVAILABLE','AUTH_NOT_READY','AUTH_REAUTH_REQUIRED','AUTH_TEMPORARY_UNAVAILABLE','AUTH_INTERNAL_ERROR']);
function failure(code) {const safe=SAFE_CODES.has(code)?code:'AUTH_INTERNAL_ERROR';return Object.assign(new Error(safe),{code:safe});}

// Deliberately has no filesystem, OAuth client, refresh token or fetch dependency.
export class SharedGoogleAuthClient {
  constructor({tokenFile,socketPath=process.env.TERMUX_GOOGLE_AUTH_SOCKET || tokenFile+'.service.sock',timeoutMs=35000}) {
    this.socketPath=socketPath;this.timeoutMs=timeoutMs;this.lastAccess=null;
  }
  async accessToken(force=false) {return force?this.forceRefresh(this.lastAccess):this.request('access');}
  async forceRefresh(rejectedAccessToken=this.lastAccess) {return this.request('refresh',rejectedAccessToken);}
  async request(operation,rejectedAccessToken) {
    const value=await new Promise((resolve,reject)=>{
      let socket;try{socket=net.createConnection(this.socketPath);}catch{reject(failure('AUTH_SERVICE_UNAVAILABLE'));return;}let raw='',settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
      socket.setTimeout(this.timeoutMs,()=>finish(failure('AUTH_SERVICE_UNAVAILABLE')));
      socket.on('error',()=>finish(failure('AUTH_SERVICE_UNAVAILABLE')));
      socket.on('end',()=>{if(!settled)finish(failure('AUTH_SERVICE_UNAVAILABLE'));});
      socket.on('connect',()=>socket.write(JSON.stringify({operation,...(typeof rejectedAccessToken==='string'?{rejected_access_token:rejectedAccessToken}:{})})+'\n'));
      socket.on('data',chunk=>{
        raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>32768)return finish(failure('AUTH_INTERNAL_ERROR'));
        if(!raw.includes('\n'))return;
        let reply;try{reply=JSON.parse(raw.slice(0,raw.indexOf('\n')));}catch{return finish(failure('AUTH_INTERNAL_ERROR'));}
        if(!reply||typeof reply!=='object'||Array.isArray(reply))return finish(failure('AUTH_INTERNAL_ERROR'));
        if(!reply.ok)return finish(failure(reply.error_code));
        if(typeof reply.access_token!=='string'||!reply.access_token)return finish(failure('AUTH_NOT_READY'));
        finish(null,reply.access_token);
      });
    });this.lastAccess=value;return value;
  }
}
