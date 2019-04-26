
const path = require('path');
const songs = {
	"L_S_2A_spe_A.mp3": "恬娜",
	"L_S_2A_spe_B.mp3": "彼得",
	"L_S_2A_U1_Part1.mp3": "格得",    
	"L_S_2A_U3_Part1.mp3": "恶瑞拜尔",    
	"L_S_2A_U5_Part1.mp3": "索契无名者",    
	"L_S_2A_U1_Part2.mp3": "龙",    
	"L_S_2A_U3_Part2.mp3": "女祭司",    
	"L_S_2A_U5_Part2.mp3": "亚刃",    
	"L_S_2A_U2_Part1.mp3": "欧吉安",    
	"L_S_2A_U4_Part1.mp3": "黎明踏浪",    
	"L_S_2A_U6_Part1.mp3": "弓伈岛",    
	"L_S_2A_U2_Part2.mp3": "极西之地",    
	"L_S_2A_U4_Part2.mp3": "柔克",    
	"L_S_2A_U6_Part2.mp3": "雀鹰",    
};

songdatas = [];
for(const name in songs){
	const label = songs[name];
	songdatas.push({
		"name": path.basename(name,'.mp3'),
		"artist": label,
		"album": "We Are to Answer",
		"url": `./bin/${name}`,
		"cover_art_url": "./album-art/we-are-to-answer.jpg"
	});
}
console.log(songdatas);

console.log(Object.keys(songs).length);