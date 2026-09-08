import fs from 'fs';

/*
  The repository the update chain points at. GitHub Actions sets
  GITHUB_REPOSITORY to `owner/repo`, so this follows whichever fork the workflow
  runs in -- which is the only correct answer: the signatures written into
  update.json are produced by that fork's signing key, and clients verify them
  against the `pubkey` baked into its build. Pointing anywhere else hands users
  assets their app will refuse.

  The `https://dl.pot-app.com/` prefix these URLs used to carry is upstream's
  own download mirror. It proxies pot-app's releases, not a fork's, so it is
  gone rather than repointed.
*/
const REPO = process.env.GITHUB_REPOSITORY ?? 'JasonWues/gloss';
const RELEASES = `https://github.com/${REPO}/releases/download`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

async function resolveUpdater() {
    if (process.env.GITHUB_TOKEN === undefined) {
        throw new Error('GITHUB_TOKEN is required');
    }

    const TOKEN = process.env.GITHUB_TOKEN;
    let version = await getVersion(TOKEN);
    let changelog = await getChangeLog(TOKEN);

    const darwin_aarch64 = `${RELEASES}/${version}/Gloss_${version}_aarch64.app.tar.gz`;
    const darwin_aarch64_sig = await getSignature(`${darwin_aarch64}.sig`);
    const darwin_x86_64 = `${RELEASES}/${version}/Gloss_${version}_x64.app.tar.gz`;
    const darwin_x86_64_sig = await getSignature(`${darwin_x86_64}.sig`);
    const windows_x86_64 = `${RELEASES}/${version}/Gloss_${version}_x64-setup.nsis.zip`;
    const windows_x86_64_sig = await getSignature(`${windows_x86_64}.sig`);
    const windows_i686 = `${RELEASES}/${version}/Gloss_${version}_x86-setup.nsis.zip`;
    const windows_i686_sig = await getSignature(`${windows_i686}.sig`);
    const windows_aarch64 = `${RELEASES}/${version}/Gloss_${version}_arm64-setup.nsis.zip`;
    const windows_aarch64_sig = await getSignature(`${windows_aarch64}.sig`);
    const linux_x86_64 = `${RELEASES}/${version}/Gloss_${version}_amd64.AppImage.tar.gz`;
    const linux_x86_64_sig = await getSignature(`${linux_x86_64}.sig`);
    const linux_aarch64 = `${RELEASES}/${version}/Gloss_${version}_aarch64.AppImage.tar.gz`;
    const linux_aarch64_sig = await getSignature(`${linux_aarch64}.sig`);

    let updateData = {
        name: version,
        notes: changelog,
        pub_date: new Date().toISOString(),
        platforms: {
            'darwin-aarch64': { signature: darwin_aarch64_sig, url: darwin_aarch64 },
            'darwin-x86_64': { signature: darwin_x86_64_sig, url: darwin_x86_64 },
            'windows-x86_64': { signature: windows_x86_64_sig, url: windows_x86_64 },
            'windows-i686': { signature: windows_i686_sig, url: windows_i686 },
            'windows-aarch64': { signature: windows_aarch64_sig, url: windows_aarch64 },
            'linux-x86_64': { signature: linux_x86_64_sig, url: linux_x86_64 },
            /*
              All three Linux entries used to be `darwin_aarch64` -- the macOS
              ARM .app.tar.gz -- so a Linux machine asking for an update was
              handed a macOS bundle. i686 and armv7 are gone with the build
              targets; aarch64 now points at the AppImage it always meant to.
            */
            'linux-aarch64': { signature: linux_aarch64_sig, url: linux_aarch64 },
        },
    };
    fs.writeFile('./update.json', JSON.stringify(updateData), (e) => {
        console.log(e);
    });
}

async function getVersion(token) {
    const res = await fetch(LATEST_RELEASE_API, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.ok) {
        let data = await res.json();
        if (data['tag_name']) {
            return data['tag_name'];
        }
    }
}

async function getChangeLog(token) {
    const res = await fetch(LATEST_RELEASE_API, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.ok) {
        let data = await res.json();
        if (data['body']) {
            let changelog_md = data['body'];

            return changelog_md;
        }
    }
}

async function getSignature(url) {
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (response.ok) {
        return response.text();
    } else {
        return '';
    }
}

resolveUpdater().catch(console.error);
