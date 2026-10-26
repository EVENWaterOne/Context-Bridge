export interface Point { x: number; y: number }

/** Keep callouts next to the moving joints and within the model's own viewport. */
export function layoutJointLabels(anchors: Point[], width: number, height: number, sizes: {width:number;height:number}[]) {
  const clamp = (v:number,min:number,max:number) => Math.max(min,Math.min(max,v));
  const placed: {x:number;y:number;width:number;height:number}[] = [];
  return anchors.map((anchor,i) => {
    const pin = {x:anchor.x * width,y:anchor.y * height}, size = sizes[i];
    const x = clamp(i >= 2 ? pin.x + 25 : pin.x - size.width - 25,8,width - size.width - 8);
    let y = clamp(pin.y + [30,-22,0,-18][i],size.height/2 + 8,height - size.height/2 - 8);
    if(pin.x>=x-6&&pin.x<=x+size.width+6&&Math.abs(y-pin.y)<size.height/2+10){
      y=clamp(pin.y+(i===1?-1:1)*(size.height/2+12),size.height/2+8,height-size.height/2-8);
    }
    for (const previous of placed) {
      if (x < previous.x + previous.width + 8 && x + size.width + 8 > previous.x && Math.abs(y - previous.y) < (size.height + previous.height)/2 + 8) {
        y = clamp(previous.y - (size.height + previous.height)/2 - 10,size.height/2 + 8,height - size.height/2 - 8);
      }
    }
    placed.push({x,y,...size});
    return {pin,x,y,end:{x:clamp(pin.x,x,x + size.width),y}};
  });
}

export function fitSquareAnchors(anchors: Point[], width:number, height:number) {
  const side = Math.min(width,height);
  return anchors.map(p => ({x:((width-side)/2 + p.x*side)/width,y:((height-side)/2 + p.y*side)/height}));
}
