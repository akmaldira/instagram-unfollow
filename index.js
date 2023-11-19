import Bluebird from "bluebird";
import dotenv from "dotenv";
import fs from "fs";
import inquirer from "inquirer";
import {
  IgApiClient,
  IgLoginTwoFactorRequiredError,
} from "instagram-private-api";

dotenv.config();

const containsWord = process.env.NOT_UNFOLLOW_IF_CONTAINS
  ? process.env.NOT_UNFOLLOW_IF_CONTAINS.split(", ")
  : [];
const ig = new IgApiClient();

ig.state.generateDevice(process.env.IG_USERNAME);

function fakeSave(data) {
  fs.writeFileSync("state.json", JSON.stringify(data));
  return data;
}

function fakeExists() {
  if (fs.existsSync("state.json")) {
    return true;
  }
  return false;
}

function fakeLoad() {
  // here you would load the data
  const data = fs.readFileSync("state.json");
  return JSON.parse(data);
}

(async () => {
  const ig = new IgApiClient();
  ig.state.generateDevice(process.env.IG_USERNAME);
  ig.state.proxyUrl = process.env.IG_PROXY;
  ig.request.end$.subscribe(async () => {
    const serialized = await ig.state.serialize();
    delete serialized.constants;
    fakeSave(serialized);
  });
  if (fakeExists()) {
    await ig.state.deserialize(fakeLoad());
  }
  await Bluebird.try(() =>
    ig.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD)
  )
    .catch(IgLoginTwoFactorRequiredError, async (err) => {
      const { username, totp_two_factor_on, two_factor_identifier } =
        err.response.body.two_factor_info;
      // decide which method to use
      const verificationMethod = totp_two_factor_on ? "0" : "1"; // default to 1 for SMS
      // At this point a code should have been sent
      // Get the code
      const { code } = await inquirer.prompt([
        {
          type: "input",
          name: "code",
          message: `Enter code received via ${
            verificationMethod === "1" ? "SMS" : "TOTP"
          }`,
        },
      ]);
      // Use the code to finish the login process
      return ig.account.twoFactorLogin({
        username,
        verificationCode: code,
        twoFactorIdentifier: two_factor_identifier,
        verificationMethod, // '1' = SMS (default), '0' = TOTP (google auth for example)
        trustThisDevice: "1", // Can be omitted as '1' is used by default
      });
    })
    .catch((e) => {
      if (e.response?.body?.message === "challenge_required") {
        console.log("Challenge required");
      } else {
        console.error(
          "An error occurred while processing two factor auth",
          e,
          e.stack
        );
        process.exit(1);
      }
    });

  const followersFeed = ig.feed.accountFollowers(ig.state.cookieUserId);
  const followingFeed = ig.feed.accountFollowing(ig.state.cookieUserId);

  const followers = await getAllItemsFromFeed(followersFeed);
  const following = await getAllItemsFromFeed(followingFeed);
  const followersUsername = new Set(followers.map(({ username }) => username));
  const notFollowingYou = following.filter(
    ({ username }) => !followersUsername.has(username)
  );

  for (const user of notFollowingYou) {
    if (containsWord.some((c1) => user.username.includes(c1))) {
      console.log(
        `Skipping ${user.username} because it's in the list of words to not unfollow`
      );
      continue;
    }

    console.log(`Unfollowing ${user.username}`);

    await ig.friendship.destroy(user.pk);
    /*
        Time, is the delay which is between 1 second and 7 seconds.
        Creating a promise to stop the loop to avoid api spam
     */
    const time = Math.round(Math.random() * 6000) + 1000;
    await new Promise((resolve) => setTimeout(resolve, time));
  }
})();

/**
 * Source: https://github.com/dilame/instagram-private-api/issues/969#issuecomment-551436680
 * @param feed
 * @returns All items from the feed
 */

async function getAllItemsFromFeed(feed) {
  let items = [];
  do {
    items = items.concat(await feed.items());
  } while (feed.isMoreAvailable());
  return items;
}
