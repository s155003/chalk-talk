# Application write-up (draft)

A draft answer for the Mays Applied AI Fellow prompt, "describe something you have built with AI and share a link." Rewrite it in your own voice, add the live link once deployed, and cut anything you would not say out loud.

---

**Chalk Talk: call a play for any college team, scored by what actually happened**

Live demo: [link]. Source: https://github.com/s155003/chalk-talk

Every Saturday, millions of people yell at a coordinator for the call he just made. None of them can check whether they were right. Chalk Talk lets you call the play yourself, for any of the 138 FBS programs against any defense, and scores it with real plays from this season.

You pick an offense and a defense. The board shows both teams' actual starters, inferred from the play-by-play: who carries, who gets targeted, who makes plays on defense. You pick a situation and a call: hand it to a specific back, keep it with the quarterback, or throw to a specific receiver. The simulator then plays the snap a thousand times, and every one of those snaps is a real play. Half are drawn from what that offense, or that player, has done on that kind of play this season, narrowed to the same down and distance when there are enough of them. Half are drawn from what that defense has actually allowed. Each keeps its real yards, sacks, interceptions and fumbles, then gets converted into expected points for the situation you set, so four yards on third and three scores better than eight on third and twelve. One button compares every available call and ranks them. A scouting report shows what each side has done against the national average, down by down.

The AI is an offensive coordinator played by Claude. It has the simulator, the comparison and the scouting report as tools. Ask it what to call on third and four and it runs the numbers, puts its choice on the board, and tells you why in a few sentences, including how big the sample is and when the defense's history is doing most of the work. It is instructed never to quote a number it did not get from a tool, and everything on the results panel is arithmetic you can check against it.

There is a second page built on NFL player-tracking data, where you draw routes and see how open they really get against each coverage. That one taught me the method; the college page is where I wanted to use it, because that is the data people argue about on Saturdays.

What I learned building it: the hard decision in an AI product is what the model decides and what the code decides. The code holds every play and does the scoring, because that has to be right every time and has to be checkable. The model reads the results and coaches, because that takes judgment. I also learned to say what the data cannot tell you: the public feed has no tackles, no formations and no coverages, and the page says so.

Built with vanilla JavaScript, Node serverless functions, Python for the data pipeline, and the Claude API with tool use. Data: cfbfastR play-by-play updated weekly, and the NFL Big Data Bowl.

---

About 520 words between the rules. Trim to the form's limit.
