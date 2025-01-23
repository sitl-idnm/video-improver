const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const execAsync = util.promisify(exec);

async function installFfmpeg() {
    const platform = os.platform();

    try {
        switch (platform) {
            case 'win32':
                await installFfmpegWindows();
                break;
            case 'darwin':
                await installFfmpegMac();
                break;
            case 'linux':
                await installFfmpegLinux();
                break;
            default:
                throw new Error(`Неподдерживаемая платформа: ${platform}`);
        }
    } catch (error) {
        console.error('Ошибка при установке ffmpeg:', error);
        throw error;
    }
}

async function installFfmpegWindows() {
    try {
        // Проверяем наличие chocolatey
        await execAsync('choco -v');
    } catch {
        console.log('Установка Chocolatey...');
        const installCmd = `@"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -InputFormat None -ExecutionPolicy Bypass -Command "[System.Net.ServicePointManager]::SecurityProtocol = 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))"`;
        await execAsync(installCmd);
    }

    console.log('Установка ffmpeg через Chocolatey...');
    await execAsync('choco install ffmpeg -y');
}

async function installFfmpegMac() {
    try {
        // Проверяем наличие brew
        await execAsync('brew -v');
    } catch {
        console.log('Установка Homebrew...');
        await execAsync('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
    }

    console.log('Установка ffmpeg через Homebrew...');
    await execAsync('brew install ffmpeg');
}

async function installFfmpegLinux() {
    console.log('Установка ffmpeg через apt...');
    await execAsync('sudo apt-get update && sudo apt-get install -y ffmpeg');
}

module.exports = { installFfmpeg };
