# Quiz Club

A live quiz game for friends. The host picks a quiz and shares the invite link, friends open it and type a name, and everyone plays at the same time. Faster correct answers score more.

- **Players** need only the link. No accounts.
- **Quiz builder** (`/builder`) is protected by your password.
- **The server** runs the timer and checks answers, so nobody can see the correct answer early.
- **Avatars and languages:** players pick an emoji avatar, and the EN / RU switch in the header changes the interface language. Quiz questions stay in the language they were written in.

> The game was first called Buzzer Club. The GitHub repository, the Render service (`render.yaml`) and the MongoDB database keep the old `buzzer-club` / `buzzerclub` names on purpose: renaming the Render service would create a new site at a new address, and renaming the database would hide the saved quizzes.

## Try it on your computer

```bash
npm install
```

In PowerShell:

```powershell
$env:ADMIN_PASSWORD = "pick-a-password"; npm start
```

Open http://localhost:3000. Only devices on your own Wi-Fi can reach it this way. To play with remote friends, put it online (below).

## Put it online (free)

You need three free accounts: **GitHub** (holds the code), **MongoDB Atlas** (keeps your quizzes safe), and **Render** (runs the game).

### 1. MongoDB Atlas: somewhere to keep your quizzes

Render's free plan wipes its disk whenever the app restarts or goes to sleep. Without a database, quizzes you write in the builder would disappear. The two starter quizzes always come back.

1. Sign up at https://www.mongodb.com/cloud/atlas/register.
2. Create a **free (M0)** cluster. Any region close to you is fine.
3. When asked, create a **database user** with a username and password. Write the password down.
4. Under **Network Access**, add the IP address `0.0.0.0/0` (allow access from anywhere). Render doesn't have a fixed address.
5. Click **Connect → Drivers** and copy the connection string. It looks like
   `mongodb+srv://USER:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
   Replace `<db_password>` with the password from step 3.

### 2. GitHub: upload the code

1. Sign up at https://github.com and create a new **private** repository called `buzzer-club`.
2. Upload everything in this folder **except** `node_modules` and `data/quizzes.local.json`. You can use the "uploading an existing file" link and drag the files in, or push with git.

### 3. Render: run the game

1. Sign up at https://render.com with your GitHub account.
2. Click **New → Blueprint**, pick the `buzzer-club` repository, and confirm. Render reads `render.yaml`.
3. Fill in the two settings it asks for:
   - `ADMIN_PASSWORD`: the password for the quiz builder.
   - `MONGODB_URI`: the connection string from Atlas.
4. Wait for the deploy to finish. Your game's address is shown at the top, like `https://buzzer-club-xxxx.onrender.com`.

Bookmark that address. It never changes, and updates you push to GitHub deploy to it automatically.

## Good to know

- **First visit after a quiet spell is slow.** The free plan sleeps after 15 minutes without visitors, and the first person to open the link waits up to a minute while it wakes up. Open the page yourself a minute before game night.
- **Games live in memory.** If the server restarts mid-game, that game ends and you host a new one. Quizzes are safe in the database.
- **Adding questions with Claude:** ask Claude for questions "as Quiz Club JSON", in the format
  `{"questions":[{"q":"Question?","o":["A","B","C","D"],"c":0}]}`, where `c` is the position of the right answer counting from 0. In the builder, open a quiz, expand **Paste questions from Claude**, and paste the reply.
- **Up to 50 players** per game. Games nobody is connected to are cleaned up after 30 minutes.
