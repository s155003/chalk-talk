# Application write-up (draft)

A draft answer for the Mays Applied AI Fellow prompt, "describe something you have built with AI and share a link." Rewrite it in your own voice, add the live link once deployed, and cut anything you would not say out loud.

---

**Chalk Talk: draw a football play and simulate it on real NFL tracking data**

Live demo: [link]. Source: https://github.com/s155003/chalk-talk

Every football fan has drawn a play on a napkin. None of them know whether it would work. Chalk Talk is a whiteboard where you put five receivers on the field, give each a route, pick the coverage or a real 2022 NFL defense, and run the play a thousand times. The numbers that come back are not made up: they are sampled from what actually happened when those routes were run against that coverage in the NFL's player-tracking data.

The data is the Big Data Bowl 2025 release, nine weeks of the 2022 season with every player's position ten times a second, plus the route each receiver ran and the coverage the defense played. From it I built a set of tables: how much separation each route produces against each coverage at the moment the ball is thrown, split by whether the receiver lines up outside or in the slot; the average path of every route and of the defender covering it; how often each coverage produces a sack; how far receivers run after the catch; and how much tighter or looser each of the 32 defenses played than expected. On top of those I fitted three small models on the same plays: which receiver the quarterback throws to given how open everyone is, whether the pass is completed, and whether it is intercepted. Every outcome is converted to expected points for the down and distance you set, so the simulator knows that four yards on third and three is a good play and eight yards on third and twelve is not.

The AI is an offensive coordinator played by Claude. It has the simulator as a tool. Ask it to critique your play and it runs the play, reads the result, and tells you which receiver cannot beat man coverage and why your check-down is losing you points. Ask it for a play that beats Cover 3 on third and eight and it designs one, simulates it, draws it on your board, and explains the numbers. It is instructed never to quote a number it did not get from a run, and the results panel next to it is pure arithmetic, so you can check it.

I also tell users what the simulator does not know: protection, play action, motion, specific defenders, and the quarterback's progression. The target-choice model, fitted honestly, only gets the real target right a third of the time, which says something true about how hard quarterbacks are to predict, and the page says so.

What I learned: the valuable part of an AI product is deciding what the model decides and what the code decides. The model plays the coach because that takes judgment. The code holds the data and runs the simulation because that has to be right every time.

Built with vanilla JavaScript, Node serverless functions, Python for the data pipeline, and the Claude API with tool use. The simulation runs in the browser in about fifteen milliseconds.

---

About 520 words between the rules. Trim to the form's limit.
