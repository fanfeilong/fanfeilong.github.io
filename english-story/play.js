
const fs = require('fs');
const path = require('path');

class ok{
	static findFiles(src,ext) {
		let result = [];
	    let files = fs.readdirSync(src);
	    for (let index in files) {
	        let fileName = files[index];
	        let fileFullName = path.join(src,fileName);
	        let fileInfo = fs.statSync(fileFullName);
	        if (!fileInfo.isDirectory() && path.extname(fileName)===ext) {
	            result.push(fileName);
	        }
	    }
	    return result;
	}

	static dirExist(filePath) {
        try{
            return fs.statSync(filePath).isDirectory();
        }catch(err){
            return false;
        }
    }

    static makeDirsSync(dirpath, mode) {
        dirpath = path.normalize(dirpath);
        try {
            if (!ok.dirExist(dirpath)) {
                var pathtmp = "";
                dirpath.split(path.sep).forEach(function (dirname) {
                    if (dirname.length == 0) {
                        pathtmp = path.sep;
                    }

                    if (pathtmp.length > 0) {
                        pathtmp = path.join(pathtmp, dirname);
                    }
                    else {
                        pathtmp = dirname;
                    }

                    if (!ok.dirExist(pathtmp)) {
                        if (!fs.mkdirSync(pathtmp, mode)) {
                            return 'mkdirsync failed';
                        }
                    }

                });
            }
            return null;
        } catch (err) {
            return err;
        }
    }

}

let playDir =  __dirname;
ok.makeDirsSync(playDir);

let swfs = ok.findFiles(__dirname,'.swf');
let htmls = [];
let width = 600;
let height = 400;

let css= `html, body {
    height: 100%;
}

html {
    display: table;
    margin: auto;
}

body {
    display: table-cell;
    vertical-align: middle;
}

navigator {
    text-decoration: none;
    display: inline-block;
    padding: 8px 16px;
    width:80px;
    height:30px;
}

.previous {
    background-color: black;
    color: white;
    width:80px;
    height:30px;
    float: right;
}

.next {
    background-color: black;
    color: white;
    float: right;
    width:80px;
    height:30px;
}`;

for(let i=0;i<swfs.length;i++){
	let name = swfs[i];

	let b = 
	`<div style="border:1px solid #000; width: ${width}px; height: 470px;">
	<p >${name}</p>
    <object width="${width}" height="${height}" type="application/x-shockwave-flash">
        <param name="movie" value="${name}">
        <embed src="${name}" width="${width}" height="${height}">
        </embed>
    </object>
    </div>
    <div>`;

    if(i>0){
    	let preName= swfs[i-1];
    	b = `${b}\n<input class="next navigator" type="button" name="${preName}" value="prev" onclick="location.href='${preName}.html'">`;
    }

    if(i<swfs.length-1){
		let nextName= swfs[i+1];
    	b = `${b}\n<input class="previous navigator" type="button" name="${nextName}" value="next" onclick="location.href='${nextName}.html'">`;
    }

    b = `${b}\n</div>`;


    
    let h = `<html><head><style>\n\n${css}\n\n</style></head><body>\n\n${b}\n\n</body></html>`;
    
	let hfile = path.join(playDir,`${name}.html`);
	fs.writeFileSync(hfile,h);

	htmls.push(`${name}.html`);
}  




