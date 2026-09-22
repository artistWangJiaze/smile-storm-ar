// Shader recompilation can shift a handful of subpixel spark edges. Bound both
// mean channel error and changed-pixel count instead of comparing PNG bytes.
export async function imageDifference(page,a,b){
 if(a===b)return {mean:0,max:0,changedRatio:0};
 return page.evaluate(async({a,b})=>{
  const images=await Promise.all([a,b].map(async data=>{
   const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
   const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
   const x=c.getContext('2d');x.drawImage(image,0,0);return x.getImageData(0,0,c.width,c.height).data;
  }));
  if(images[0].length!==images[1].length)throw new Error('Capture dimensions differ');
  let sum=0,max=0,changed=0;
  for(let i=0;i<images[0].length;i+=4){
   let pixelChanged=false;
   for(let c=0;c<3;c++){const d=Math.abs(images[0][i+c]-images[1][i+c]);sum+=d;max=Math.max(max,d);pixelChanged ||= d>0;}
   if(pixelChanged)changed++;
  }
  return {mean:sum/(images[0].length*.75),max,changedRatio:changed/(images[0].length/4)};
 },{a,b});
}
