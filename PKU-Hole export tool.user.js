// ==UserScript==
// @name         PKU-Hole export tool
// @author       WindMan
// @namespace    http://tampermonkey.net/
// @version      1.2.1
// @license      MIT License
// @description  导入/导出树洞中的关注列表
// @match        https://treehole.pku.edu.cn/web/*
// @grant        none
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/465805/PKU-Hole%20export%20tool.user.js
// @updateURL https://update.greasyfork.org/scripts/465805/PKU-Hole%20export%20tool.meta.js
// ==/UserScript==



/* some global functions */

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function _getCookieObj() {
	var cookieObj = {};
	var cookieStr = document.cookie;
	var pairList = cookieStr.split(";");
	for (var _i = 0, pairList_1 = pairList; _i < pairList_1.length; _i++) {
		var pair = pairList_1[_i];
		var _a = pair.trim().split("="),
			key = _a[0],
			value = _a[1];
		cookieObj[key] = value;
	}
	return cookieObj;
}

async function readFileAsync(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		// 成功读取文件
		reader.onload = function (event) {
			resolve(event.target.result);
		};

		// 读取文件失败
		reader.onerror = function (error) {
			reject(error);
		};

		// 读取文件内容为文本
		reader.readAsText(file);
	});
}

function _authHeaders(extra) {
	return Object.assign({
		accept: "application/json, text/plain, */*",
		"accept-language": "zh-CN,zh;q=0.9",
		authorization: `Bearer ${_getCookieObj()["pku_token"]}`,
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		uuid: localStorage.getItem("pku-uuid"),
	}, extra || {});
}

// fetch with timeout + retry/backoff. Returns parsed JSON or throws after maxAttempts.
async function fetchJsonWithRetry(url, options, opts) {
	const maxAttempts = (opts && opts.maxAttempts) || 4;
	const timeoutMs = (opts && opts.timeoutMs) || 15000;
	let lastError = null;
	for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
			clearTimeout(timer);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return await response.json();
		} catch (error) {
			clearTimeout(timer);
			lastError = error;
			console.log(`fetch ${url} attempt ${attempt}/${maxAttempts} failed:`, error);
			if (attempt < maxAttempts) {
				await sleep(500 * Math.pow(2, attempt - 1));
			}
		}
	}
	throw lastError;
}


async function followedHoles() {
	const fetchList = [];
	let pages = 1024;
	for (let page = 1; page <= pages; ++page) {
		const data_ = await fetchJsonWithRetry(
			`https://treehole.pku.edu.cn/api/follow_v2?page=${page}&limit=25`,
			{
				headers: _authHeaders(),
				referrer: "https://treehole.pku.edu.cn/web/",
				referrerPolicy: "strict-origin-when-cross-origin",
				body: null,
				method: "GET",
				mode: "cors",
				credentials: "include",
			}
		);

		let data = data_.data.data;
		fetchList.push(data);

		if (data_.data.next_page_url == null) {
			break;
		}
		await sleep(50);
	}
	return fetchList;
}

async function comments(holeid) {
	const fetchList = [];
	let pages = 240;
	for (let page = 1; page <= pages; ++page) {
		const data_ = await fetchJsonWithRetry(
			`https://treehole.pku.edu.cn/api/pku_comment_v3/${holeid}?page=${page}&limit=15&sort=asc`,
			{
				headers: _authHeaders(),
				referrer: "https://treehole.pku.edu.cn/web/",
				referrerPolicy: "strict-origin-when-cross-origin",
				body: null,
				method: "GET",
				mode: "cors",
				credentials: "include",
			}
		);

		let data = data_.data.data;
		fetchList.push(data);

		if (data_.data.next_page_url == null) {
			break;
		}
		await sleep(20);
	}
	return fetchList;
}

async function getHole(holeid) {
	let data;
	try {
		data = await fetchJsonWithRetry(
			`https://treehole.pku.edu.cn/api/pku/${holeid}/`,
			{
				headers: _authHeaders(),
				referrer: "https://treehole.pku.edu.cn/web/",
				referrerPolicy: "strict-origin-when-cross-origin",
				body: null,
				method: "GET",
				mode: "cors",
				credentials: "include",
			}
		);
	} catch (error) {
		console.log(`getHole(${holeid}) gave up after retries:`, error);
		return null;
	}
	if (data.code != 20000) {
		return null;
	}
	return data.data;
}



function downloadFile(text, filename) {
	const blob = new Blob([text], { type: "text/plain" });

	const downloadLink = document.createElement("a");
	downloadLink.download = filename;
	downloadLink.href = URL.createObjectURL(blob);
	downloadLink.textContent = "Download";

	document.body.appendChild(downloadLink);
	downloadLink.click();
	URL.revokeObjectURL(downloadLink.href);
}

function comment2text(comments_) {
	if (comments_[0] != undefined) { // 排除没有评论的情况
		let buffer_ = "";
		for (let i = 0; i < comments_.length; i++) {
			let comment_list_ = comments_[i];
			for (let j = 0; j < comment_list_.length; j++) {
				let comment_ = comment_list_[j];
				buffer_ += `${comment_.name}: ${comment_.text}\n`;
			}
		}
		return buffer_;
	}
	return "";
}

function extractPidFromText(text) {
	// extract pids from text
	if (text == null) {
		return [];
	}
	let regex = /\b\d{5,7}\b/g;
	let matches = text.match(regex);
	return matches == null ? [] : matches;
}

function processExtract(hole, comments_str, mode) {
	let pids = [];
	// mode > 1 (extract from text)
	if (mode > 1) {
		extractPidFromText(hole.text).forEach(pid => pids.push(pid));
	}
	// mode > 2 (extract from comments)
	if (mode > 2) {
		extractPidFromText(comments_str).forEach(pid => pids.push(pid));
	}
	return pids;
}

async function exportCitedHoles(buttonElement, holeids, file_num) {
	let buffer = "";
	let jsonbuffer = {
		"holes": [],
		"comments": []
	};
	let holenum = 0;
	for (let i = 0; i < holeids.length; i++) {
		let holeid = holeids[i];
		let hole = await getHole(holeid);

		if (hole && hole.pid) {
			console.log(`export cited hole ${hole.pid}`);
			buffer += `Id:${hole.pid}  Likenum:${hole.likenum}  Reply:${hole.reply
				}  Time:${new Date(hole.timestamp * 1000).toLocaleString()}\n`;
			let comments_ = await comments(hole.pid);
			jsonbuffer.holes.push(hole);
			jsonbuffer.comments.push(comments_);
			holenum += 1;
			buttonElement.textContent = holenum.toString();
			buffer += `洞主: ${hole.text}\n`;
			buffer += comment2text(comments_);
			buffer += "\n======================\n\n";
			await sleep(10);
		}

		if ((i + 1) % 100 == 0 || i == holeids.length - 1) {
			downloadFile(buffer, "export-cited-part-" + (file_num + 1).toString() + ".txt");
			downloadFile(JSON.stringify(jsonbuffer), "export-cited-part-" + (file_num + 1).toString() + ".json");
			file_num += 1;
			buffer = "";
			jsonbuffer = {
				"holes": [],
				"comments": []
			};
		}
	}
}

async function exportFollowedHoles(buttonElement, mode) {
	// mode:
	// 1: just export followed holes
	// 2: export followed holes and holes in the text
	// 3: export followed holes and holes in the text and comments
	let buffer = "";
	let jsonbuffer = {
		"holes": [],
		"comments": []
	};
	let holenum = 0;
	let file_num = 0;
	let extracted_pids = new Array();
	let followsholes = await followedHoles();
	// unroll
	let holes = [];
	for (let i = 0; i < followsholes.length; i++) {
		let holelist = followsholes[i];
		for (let j = 0; j < holelist.length; j++) {
			holes.push(holelist[j]);
		}
	}


	for (let i = 0; i < holes.length; i++) {
		let hole = holes[i];
		console.log(`export followed hole ${hole.pid}`);
		buffer += `Id:${hole.pid}  Likenum:${hole.likenum}  Reply:${hole.reply
			}  Time:${new Date(hole.timestamp * 1000).toLocaleString()}\n`;
		let comments_ = await comments(hole.pid);
		jsonbuffer.holes.push(hole);
		jsonbuffer.comments.push(comments_);
		holenum += 1;
		buttonElement.textContent = holenum.toString();
		const comments_text = comment2text(comments_);
		buffer += `洞主: ${hole.text}\n`;
		buffer += comments_text;
		buffer += "\n======================\n\n";

		let extracted_pids_ = processExtract(hole, comments_text, mode);
		extracted_pids_.forEach(pid => extracted_pids.push(pid));

		await sleep(10);
		if ((i + 1) % 100 == 0 || i == holes.length - 1) {
			downloadFile(buffer, "export-part-" + (file_num + 1).toString() + ".txt");
			downloadFile(JSON.stringify(jsonbuffer), "export-part-" + (file_num + 1).toString() + ".json");
			file_num += 1;
			buffer = "";
			jsonbuffer = {
				"holes": [],
				"comments": []
			};
		}
	}
	// download cited holes (deduplicated; exclude pids already in followed list)
	const followed_pid_set = new Set(holes.map(h => String(h.pid)));
	const unique_cited_pids = Array.from(new Set(extracted_pids.map(String)))
		.filter(pid => !followed_pid_set.has(pid));
	if (unique_cited_pids.length > 0) {
		alert(`关注列表导出完成，现在导出被引用树洞（去重后 ${unique_cited_pids.length} 个）`);
		console.log("extracted pids (unique):");
		console.log(unique_cited_pids);
		await exportCitedHoles(buttonElement, unique_cited_pids, file_num);
	}
}

async function exportHoles(buttonElement) {
	console.log("export.");
	// get settings from user
	const confirm_ = confirm(
		"是否确定要导出关注列表？\n" +
		"每导出100条树洞生成一个文件\n" + 
		"导出时会实时显示导出树洞的数目" + 
		"\n若想要停止导出,直接刷新浏览器界面即可"
	);
	if (!confirm_) {
		alert("已取消导出");
		return;
	}

	let mode = prompt("请选择导出模式：\n" +
		"1. 【仅导出】您关注的树洞（默认）\n" +
		"2. 导出您关注的树洞以及在树洞【正文中】被引的洞\n" +
		"3. 导出您关注的树洞以及在树洞【正文和评论中】被引的洞\n" +
		"请输入1-3中的一个数字以选定模式"
		, "1");

	// bad result
	if (mode === "0") {
		alert("已取消导出");
		return;
	}
	if (!['1', '2', '3'].includes(mode)) {
		alert("输入错误，若想重试请重新点击导出按钮并输入正确的数字");
		return;
	}

	if (confirm_) {
		buttonElement.textContent = "稍候";
		await exportFollowedHoles(buttonElement, parseInt(mode));
		buttonElement.textContent = "导出";
	}

}

async function initInputElement(fileInput) {
	fileInput.multiple = true;
	fileInput.type = "file";
	fileInput.accept = ".json";
	fileInput.id = "file-input";
	fileInput.style.display = "none";
	document.body.appendChild(fileInput);
}


/*
follow a hole
return:
	"not exist" - hole not exist
	"already followed" - hole already followed
	"success" - follow success
*/
async function followHole(holeid) {
	// check if hole not exist or already followed
	// return "not exist" or "already followed" or "success" or "fail"
	const targetHole = await getHole(holeid);
	if (targetHole == null) {
		console.log(`Hole ${holeid} does not exist.`);
		return "not exist";
	}
	if (targetHole.is_follow) {
		console.log(`Hole ${holeid} is already followed.`);
		return "already followed";
	}
	try {
		const data = await fetchJsonWithRetry(`https://treehole.pku.edu.cn/api/pku_attention/${holeid}`, {
			headers: _authHeaders({
				'Cache-Control': 'no-cache',
				'Origin': 'https://treehole.pku.edu.cn',
				'Pragma': 'no-cache',
			}),
			method: 'POST',
			referrer: "https://treehole.pku.edu.cn/web/",
			mode: "cors",
			credentials: "include",
		});
		if (data.code !== 20000) {
			console.log(`Hole ${holeid} follow request returned code ${data.code}: ${data.msg}`);
			return "fail";
		}
	} catch (error) {
		console.log(`Hole ${holeid} follow request gave up:`, error);
		return "fail";
	}
	return "success";
}



async function parseInputFile(file) {
	try {
		const content = await readFileAsync(file);
		if (file.name.endsWith(".json")) {
			const fileData = JSON.parse(content);
			var pidList = new Array();
			for (const hole of fileData.holes) {
				if (hole && hole.pid) {
					pidList.push(hole.pid);
				}
			}
			return pidList;
		} else {
			return [];
		}
	} catch (error) {
		console.log(`Error reading or parsing file ${file.name}:`, error);
		return [];
	}
}


async function importHoles(buttonElement) {
	// init file input
	const fileInput = document.createElement("input");
	await initInputElement(fileInput);
	var total_holes = 0;
	var success_holes = 0;
	var skipped_holes = 0;
	var notexist_holes = 0;

	// trigger file input
	const confirm_input = confirm("是否继续选择要导入的文件？可一次导入多个，可导入多次\n（目前仅支持之前通过此插件导出的json文件作为输入）");
	if (confirm_input) {
		fileInput.click();
	}

	fileInput.onchange = async (event) => {
		const files = event.target.files;
		if (files.length === 0) {
			alert("未选择任何文件，已取消导入");
			return;
		}
		console.log(`Selected ${files.length} file(s):`);
		for (const file of files) {
			var hole_list = await parseInputFile(file);
			console.log(`parsed file ${file.name}, got ${hole_list.length} holes.`);

			for (const holeid of hole_list) {
				var result = await followHole(holeid);
				if (result === "success") {
					success_holes += 1;
					console.log(`Followed hole ${holeid} successfully.`);
				} else if (result === "already followed") {
					skipped_holes += 1;
					console.log(`Hole ${holeid} is already followed, skipped.`);
				} else if (result === "not exist") {
					notexist_holes += 1;
					console.log(`Hole ${holeid} does not exist, skipped.`);
				}
				total_holes += 1;
				buttonElement.textContent = `${total_holes}`;
				await sleep(50); // avoid too many requests
			}
		}
		buttonElement.textContent = "结束";
		// summary
		alert(`导入完成！\n总共处理文件数量: ${files.length}\n总共处理树洞数量: ${total_holes}\n成功关注数量: ${success_holes}\n` + 
					`跳过的数量（由于已经关注了）: ${skipped_holes}\n不存在的树洞数量: ${notexist_holes}`);
		// reset button text
		buttonElement.textContent = "导入/导出";
	}
}




async function entrypoint(buttonElement) {
	console.log("starting.");
	// get settings from user
	const mode_choice = prompt(
		"选择功能模式：\n" +
		"1. 导入\n" +
		"2. 导出\n" + 
		"请输入1-2中的一个数字以选定模式"
	);
	// bad result
	if (!['1', '2'].includes(mode_choice)) {
		return;
	}

	if (mode_choice === "1") {
		await importHoles(buttonElement);
	} else if (mode_choice === "2") {
		await exportHoles(buttonElement);
	}
}


(window.onload = function () {
	"use strict";
	let running = false;
	const searchbtnElement = document.querySelector("div.search-btn");
	const buttonElement = document.createElement("button");
	buttonElement.textContent = "导入/导出";
	buttonElement.style.minWidth = "75px";
	buttonElement.addEventListener("click", async function () {
		if (!running) {
			running = true;
			await entrypoint(this);
			running = false;
		}
	});
	if (searchbtnElement) {
		searchbtnElement.insertAdjacentElement("beforebegin", buttonElement);
	}
})();
