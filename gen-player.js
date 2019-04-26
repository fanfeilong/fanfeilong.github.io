
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
htmls = [];
for(const name in songs){
	const label = songs[name];
	const n = path.basename(name,'.mp3');
	songdatas.push({
		"name": n,
		"artist": label,
		"album": "We Are to Answer",
		"url": `./bin/${name}`,
		"cover_art_url": "./album-art/we-are-to-answer.jpg"
	});

	htmls.push(`
		<div class="song amplitude-song-container amplitude-play-pause" data-amplitude-song-index="0">
	      <div class="song-now-playing-icon-container">
	        <div class="play-button-container">

	        </div>
	        <img class="now-playing" src="./img/now-playing.svg"/>
	      </div>
	      <div class="song-meta-data">
	        <span class="song-title">${n}</span>
	        <span class="song-artist">${label}</span>
	      </div>
	      <a href="https://switchstancerecordings.bandcamp.com/track/risin-high-feat-raashan-ahmad" class="bandcamp-link" target="_blank">
	        <img class="bandcamp-grey" src="./img/bandcamp-grey.svg"/>
	        <img class="bandcamp-white" src="./img/bandcamp-white.svg"/>
	      </a>
	      <span class="song-duration">3:30</span>
	    </div>
	`)
}
console.log(songdatas);

console.log(htmls.join('\n\n'));

console.log(Object.keys(songs).length);