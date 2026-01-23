document.getElementById('build-showcase').addEventListener('click', buildShowcase);
document.getElementById('reset-showcase').addEventListener('click', resetShowcase);
document.getElementById('share-link').addEventListener('click', generateShareableLink);

let top25Songs = [];
let top10Albums = [];

function buildShowcase() {
    const fileInput = document.getElementById('csv-upload');
    const file = fileInput.files[0];

    if (!file) {
        alert('Please upload a CSV file!');
        return;
    }

    const reader = new FileReader();
    reader.onload = function (event) {
        const csvContent = event.target.result;
        parseCSV(csvContent);
    };
    reader.readAsText(file);
}

function parseCSV(csvContent) {
    const rows = csvContent.split('\n');
    const songs = [];

    for (let i = 0; i < rows.length; i++) {
        const cols = rows[i].split(',');

        if (cols.length < 3) continue; // Skip invalid rows

        const song = {
            rank: 26 - i, // Reverse order: line 25 = rank 1
            track: cols[0].trim(),
            artist: cols[1].trim(),
            album: cols[2].trim(),
            previewUrl: `https://itunes.apple.com/search?term=${encodeURIComponent(cols[0].trim())}&entity=song&limit=1`
        };

        songs.push(song);
    }

    top25Songs = songs;

    displaySongs();
}

function displaySongs() {
    const songGrid = document.getElementById('song-grid');
    songGrid.innerHTML = ''; // Clear any existing content

    top25Songs.forEach(song => {
        const songItem = document.createElement('div');
        songItem.classList.add('song-item');

        const albumCover = document.createElement('img');
        albumCover.classList.add('cover');
        albumCover.src = `https://coverartarchive.org/release/${song.album}/front.jpg`;
        albumCover.alt = song.album;
        albumCover.addEventListener('click', () => playPreview(song));

        const rankText = document.createElement('span');
        rankText.textContent = `#${song.rank}`;

        songItem.appendChild(albumCover);
        songItem.appendChild(rankText);

        songGrid.appendChild(songItem);
    });
}

function playPreview(song) {
    fetch(song.previewUrl)
        .then(response => response.json())
        .then(data => {
            const audioPreview = new Audio(data.results[0].previewUrl);
            audioPreview.play();
            displaySongName(song);
        });
}

function displaySongName(song) {
    const songNameDisplay = document.createElement('p');
    songNameDisplay.textContent = `${song.track} by ${song.artist}`;
    document.querySelector('.song-showcase').appendChild(songNameDisplay);
}

function resetShowcase() {
    document.getElementById('song-grid').innerHTML = '';
    document.getElementById('album-grid').innerHTML = '';
    document.getElementById('csv-upload').value = '';
    document.querySelector('.share-section').style.display = 'none';
}

function generateShareableLink() {
    const link = window.location.href + "?showcase=true"; // Basic link structure
    document.getElementById('generated-link').textContent = `Share this link: ${link}`;
    document.querySelector('.share-section').style.display = 'block';
}
