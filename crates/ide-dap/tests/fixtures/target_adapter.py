import sys,json,os,socket
root=os.environ.get("FAKE_ROOT","/app")
r=sys.stdin.buffer; w=sys.stdout.buffer
seq=0
def send(v):
 global seq
 seq+=1; v['seq']=seq
 b=json.dumps(v).encode(); w.write(('Content-Length: %d\r\n\r\n'%len(b)).encode()+b); w.flush()
while True:
 line=r.readline()
 if not line: break
 n=int(line.split(b':')[1]); assert r.readline()==b'\r\n'
 q=json.loads(r.read(n)); c=q['command']; a=q.get('arguments',{}); body={}
 if c=='initialize': body={'supportsConfigurationDoneRequest':True}
 if c=='launch':
  if 'program' in a: assert a['program']==root+'/main.py',a
  if os.environ.get('FAKE_CONNECT_BACK'):
   listener=socket.socket(); listener.bind(('127.0.0.1',a['port'])); listener.listen()
  assert a['cwd']==root,a
  send({'type':'event','event':'initialized'})
 if c=='setBreakpoints':
  assert a['source']['path']==root+'/main.py',a
  body={'breakpoints':[{'verified':True,'line':3}]}
 if c=='threads': body={'threads':[{'id':1,'name':'target main'}]}
 if c=='configurationDone': send({'type':'event','event':'stopped','body':{'reason':'breakpoint','threadId':1,'allThreadsStopped':True}})
 if c=='stackTrace' and os.environ.get('FAKE_CONNECT_BACK'):
  client,_=listener.accept(); assert client.recv(4096).decode()==root+'/main.py'; client.close()
 if c=='stackTrace': body={'stackFrames':[{'id':1,'name':'main','line':3,'column':1,'source':{'path':root+'/main.py'}}]}
 send({'type':'response','request_seq':q['seq'],'command':c,'success':True,'body':body})
 if c=='disconnect': break
