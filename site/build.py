import base64, os
root=os.path.dirname(os.path.abspath(__file__)); art=os.path.join(root,'..','art')
uri=lambda f:'data:image/png;base64,'+base64.b64encode(open(os.path.join(art,f),'rb').read()).decode()
src=open(os.path.join(root,'index.src.html')).read().replace('@@ROBOT_EMPTY@@',uri('robot64-empty.png')).replace('@@ROBOT@@',uri('robot64.png'))
os.makedirs(os.path.join(root,'dist'),exist_ok=True)
open(os.path.join(root,'dist','proven-preview.html'),'w').write(src.replace('<script src="config.js"></script>','<script>window.PROVEN_CFG={NAME:"PROVEN",TICKER:"PROVEN",CA:"",X:"",API:""};</script>'))
cut=src.index('<div id="intro"')
head=src[:cut].replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
full='<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'+head+'<style>[hidden]{display:none!important}body{margin:0}img{max-width:100%}</style>\n</head>\n<body>\n'+src[cut:]+'\n</body>\n</html>\n'
open(os.path.join(root,'dist','index.html'),'w').write(full)
print(len(full))
