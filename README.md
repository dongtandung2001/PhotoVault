# Wedding Photo & Video Viewer Website

A stunning, fast, and ultra-cheap gallery website for sharing your wedding photos and videos with friends and family. 

### Why this architecture?
*   **Cost: ~$0.15/month** for 20GB of photos and videos.
*   **Bandwidth: $0.00** (Cloudflare R2 has **free egress/download fees**, unlike AWS S3 which would charge you for every gigabyte downloaded by family).
*   **Web Hosting: Free** (Cloudflare Pages hosts the static site at no cost).
*   **Mobile-Optimized**: High-resolution photos (5–12MB each) are compressed locally into beautiful, fast-loading WebP images (20–40KB for thumbnails, 200–400KB for full screen).
*   **Privacy Protected**: Secured by a client-side password gate to prevent search engines from index-crawling your private family moments.

---

## Step 1: Set up Cloudflare R2 (Storage)

1.  **Sign up** for a free account at [cloudflare.com](https://www.cloudflare.com/).
2.  In the left sidebar, navigate to **R2 Object Storage** and click **Create bucket**.
3.  Name your bucket (e.g., `wedding-gallery-2026`) and select the **Location: Automatic** (or your closest region). Click **Create Bucket**.
4.  Once created, click on your bucket, go to the **Settings** tab:
    *   Under **CORS Policy**, click **Add CORS Policy** and paste the following configuration (this allows the website to download images from the storage bucket):
        ```json
        [
          {
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedOrigins": ["*"],
            "ExposeHeaders": []
          }
        ]
        ```
    *   Under **Public Access**, click **Connect Domain** (if you have your own domain name) OR **Allow Access** under **R2.dev Subdomain** to enable a free public link (looks like `https://pub-xxxxxx.r2.dev`). Note this public subdomain link down!

---

## Step 2: Retrieve API Keys (for Uploading)

To let the python script upload files directly to your bucket:
1.  Go back to the main **R2** dashboard page.
2.  Click **Manage R2 API Tokens** on the right side.
3.  Click **Create API Token**.
4.  Configure the token:
    *   **Token name**: `wedding-uploader`
    *   **Permissions**: **Edit** (this allows uploading new objects).
    *   **TTL**: Select a time (e.g., 1 year, or clear it after uploading).
5.  Click **Create API Token** and **copy** these three values:
    *   `Access Key ID`
    *   `Secret Access Key`
    *   `Account ID` (found in the endpoint URL: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)

---

## Step 3: Run the Local Media Optimizer & Uploader

This script runs on your computer. It processes your huge raw photos/videos into lightweight versions and uploads them to Cloudflare R2 automatically.

### 1. Install Dependencies
Make sure Python 3 is installed, then run in your terminal:
```bash
pip install -r requirements.txt
```

### 2. Organize your Raw Media
Create a folder named `raw_photos` in the project root directory. Group your photos/videos into subfolders. The folder names will automatically become the navigation tabs in the gallery!
```
raw_photos/
├── 01_Ceremony/
│   ├── photo1.jpg
│   └── video1.mp4
├── 02_Reception/
│   ├── photo2.jpg
│   └── photo3.heic
└── 03_Portraits/
    └── photo4.jpg
```
*(HEIC files from iPhones are automatically supported and converted using Mac's built-in image processor!)*

### 3. Run the Script
Run the script in your terminal:
```bash
python3 process_photos.py
```
*   The script will compress images, extract video covers (if `ffmpeg` is installed), and output `thumbnails/` and `optimized/` directories directly in the project root directory.
*   It will ask you if you want to upload to R2. Say `y` and paste your R2 credentials (they will be saved securely to `.env` so you don't have to enter them next time).
*   The script performs **incremental uploads**: if you run it again after adding new photos, it will skip files already processed/uploaded, saving you bandwidth and hours of time!

---

## Step 4: Configure Passwords & R2 URLs in `.env`

Passwords and R2 bucket URLs are managed securely using the `.env` file in the project root (which is automatically git-ignored to prevent leaking them).

1. Open `.env` and configure your settings:
   ```env
   # Passwords (will be hashed automatically during processing)
   GALLERY_PASSWORD=wedding2026
   FAMILY_PASSWORD=family2026

   # R2 Public URLs for each collection (match the subdirectory name in raw_photos)
   R2_BUCKET_URL_DAMCUOISAIGON=https://pub-yourdomain.r2.dev
   R2_BUCKET_URL_DAMCUOISOCTRANG=https://pub-86972fb9a9c542b7bc60b4213b784a8f.r2.dev/
   ```
2. If any passwords or R2 bucket URLs are missing from `.env` when you run `python3 process_photos.py`, the script will prompt you for them and save them back to `.env` automatically.
3. The script will hash the passwords and compile all public configurations into `gallery-config.json` in the root.

---

## Step 5: Deploy the Website (Free Hosting)

Now that your assets are uploaded to R2, let's deploy the static website:

1. In the left sidebar of your Cloudflare Dashboard, go to **Workers & Pages** -> **Overview** and click **Create application** -> **Pages** -> **Upload assets**.
2. Name your project (e.g., `our-wedding`).
3. Drag and drop the website files from the project root:
    *   `index.html`
    *   `style.css`
    *   `app.js`
    *   `gallery-config.json` (newly generated config file)
    *   `gallery-data.json` (generated media catalog file)
4. Click **Deploy site**.
5. Cloudflare will give you a free domain (e.g., `our-wedding.pages.dev`). You are now live!

