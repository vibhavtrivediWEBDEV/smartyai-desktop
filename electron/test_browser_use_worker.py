import asyncio
import importlib.util
import io
import json
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from browser_use.tools.service import Tools
from browser_use.tools.views import NavigateAction, SearchAction


spec = importlib.util.spec_from_file_location('browser_use_worker', Path(__file__).with_name('browser-use-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BrowserActionReviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_navigation_opens_new_tab_even_when_model_requests_current_tab(self):
        navigation = NavigateAction(url='https://example.com', new_tab=False)
        output = SimpleNamespace(action=[SimpleNamespace(navigate=navigation)])
        worker.open_navigation_in_new_tab(output)
        self.assertTrue(navigation.new_tab)
        self.assertTrue(navigation.model_dump()['new_tab'])

    async def test_search_dispatches_new_tab_navigation(self):
        class CompletedEvent:
            def __await__(self):
                return asyncio.sleep(0).__await__()

            async def event_result(self, **kwargs):
                return None

        dispatched = []
        session = SimpleNamespace(event_bus=SimpleNamespace(
            dispatch=lambda event: dispatched.append(event) or CompletedEvent()))
        search = Tools().registry.registry.actions['search'].function
        result = await search(params=SearchAction(query='three applications'), browser_session=session)
        self.assertIsNone(result.error)
        self.assertEqual(len(dispatched), 1)
        self.assertTrue(dispatched[0].new_tab)

    async def test_worker_reuses_browser_session_for_same_origin_and_closes_on_eof(self):
        messages = []
        sessions = []
        session = SimpleNamespace(kill=lambda: asyncio.sleep(0, result=sessions.append('closed')))

        async def run(request, previous):
            sessions.append((request['task'], previous))
            return session

        requests = ''.join(json.dumps({'origin': 'https://example.com', 'task': task}) + '\n' for task in ('first', 'second'))
        with patch.object(worker, 'main', side_effect=run), patch.object(worker, 'send', side_effect=messages.append), \
             patch.object(worker.sys, 'stdin', io.StringIO(requests)):
            await worker.serve()
        self.assertEqual(sessions, [('first', None), ('second', session), 'closed'])
        self.assertEqual(messages, [{'type': 'ready'}, {'type': 'ready'}])

    async def test_worker_rejects_cross_origin_reuse(self):
        requests = ''.join(json.dumps({'origin': origin, 'task': 'inspect'}) + '\n'
                           for origin in ('https://example.com', 'https://elsewhere.example'))
        session = SimpleNamespace(kill=lambda: asyncio.sleep(0))
        with patch.object(worker, 'main', return_value=session), patch.object(worker.sys, 'stdin', io.StringIO(requests)), \
             patch.object(worker, 'send'):
            with self.assertRaisesRegex(ValueError, 'approved origin'):
                await worker.serve()

    async def test_incomplete_run_keeps_its_browser_session(self):
        closed = []
        session = SimpleNamespace(kill=lambda: asyncio.sleep(0, result=closed.append(True)))

        class MockAgent:
            def __init__(self, **kwargs):
                self.browser_session = session

            async def run(self, max_steps):
                return SimpleNamespace(is_done=lambda: False)

        request = {'provider': 'zai', 'origin': 'https://example.com', 'chrome': '/path/to/chrome', 'task': 'inspect'}
        with patch.object(worker, 'Agent', MockAgent), patch.object(worker, 'BrowserProfile'), \
             patch.object(worker, 'ChatOpenAI'), patch.object(worker, 'send'), \
             patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}):
            with self.assertRaisesRegex(worker.TaskIncomplete, 'did not complete') as failure:
                await worker.main(request)
        self.assertIs(failure.exception.session, session)
        self.assertEqual(closed, [])

    async def test_worker_reuses_session_after_incomplete_task(self):
        events = []
        session = SimpleNamespace(kill=lambda: asyncio.sleep(0, result=events.append('closed')))

        async def run(request, previous):
            events.append((request['task'], previous))
            if request['task'] == 'first':
                raise worker.TaskIncomplete('Did not complete after 40 steps', session)
            return session

        requests = ''.join(json.dumps({'origin': 'https://example.com', 'task': task}) + '\n' for task in ('first', 'second'))
        messages = []
        with patch.object(worker, 'main', side_effect=run), patch.object(worker, 'send', side_effect=messages.append), \
             patch.object(worker.sys, 'stdin', io.StringIO(requests)):
            await worker.serve()
        self.assertEqual(events, [('first', None), ('second', session), 'closed'])
        self.assertEqual(messages, [{'type': 'task_failed', 'message': 'Did not complete after 40 steps'},
                                    {'type': 'ready'}, {'type': 'ready'}])

    async def test_offscreen_mailto_is_read_from_approved_page_only(self):
        origin = 'https://benosupport.com'
        state = SimpleNamespace(url=origin + '/contact', dom_state=SimpleNamespace(selector_map={}))

        class Page:
            async def evaluate(self, script, requested_origin):
                self.assert_origin(requested_origin)
                self.assert_guard(script)
                return json.dumps(['mailto:external@gmail.com', 'mailto:info@benosupport.com?subject=Hello'])

            def assert_origin(self, requested_origin):
                assert requested_origin == origin

            def assert_guard(self, script):
                assert 'location.origin === origin' in script

        page = Page()
        session = SimpleNamespace(get_current_page=lambda: asyncio.sleep(0, result=page))
        self.assertEqual(await worker.official_email_in_browser(state, origin, session), 'info@benosupport.com')
        other = SimpleNamespace(url='https://other.example', dom_state=state.dom_state)
        self.assertIsNone(await worker.official_email_in_browser(other, origin, session))

    async def test_official_email_requires_requested_page_and_matching_mailto_domain(self):
        def state(url, href):
            return SimpleNamespace(url=url, dom_state=SimpleNamespace(selector_map={1: SimpleNamespace(attributes={'href': href})}))

        origin = 'https://benosupport.com'
        self.assertEqual(worker.official_email_on_page(state(origin, 'mailto:info@benosupport.com?subject=Hello'), origin), 'info@benosupport.com')
        self.assertIsNone(worker.official_email_on_page(state('https://other.example', 'mailto:info@benosupport.com'), origin))
        self.assertIsNone(worker.official_email_on_page(state(origin, 'mailto:person@gmail.com'), origin))
        self.assertIsNone(worker.official_email_on_page(state(origin, 'mailto:info@benosupport.com.evil.example'), origin))

    async def test_location_address_must_be_visible_on_the_approved_origin(self):
        address = 'Government Boys Senior Secondary School, Block B, New Ashok Nagar, Delhi 110096'
        class Page:
            async def evaluate(self, script, origin):
                self.assertEqual(origin, 'https://mylocationapp.com')
                self.assertIn('location.origin === origin', script)
                return json.dumps('Your location: ' + address)

            def assertEqual(self, actual, expected):
                assert actual == expected

            def assertIn(self, value, text):
                assert value in text

        session = SimpleNamespace(get_current_page=AsyncMock(return_value=Page()))
        self.assertTrue(await worker.location_visible_on_page('Suggested saved area: ' + address,
            'https://mylocationapp.com', session))
        self.assertFalse(await worker.location_visible_on_page('Near Delhi (from IP address)',
            'https://mylocationapp.com', session))
        self.assertFalse(await worker.location_visible_on_page('Suggested saved area: Another address',
            'https://mylocationapp.com', session))
        self.assertFalse(await worker.location_visible_on_page('Suggested saved area: ' + address +
            '\nSuggested saved area: ' + address, 'https://mylocationapp.com', session))

    async def test_location_permission_is_granted_only_to_the_selected_origin(self):
        origin = 'https://mylocationapp.com'
        grant = AsyncMock()
        browser_session = SimpleNamespace(cdp_client=SimpleNamespace(send=SimpleNamespace(
            Browser=SimpleNamespace(grantPermissions=grant))))
        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']
                self.browser_session = browser_session

            async def run(self, max_steps):
                action = SimpleNamespace(action=[SimpleNamespace(navigate=SimpleNamespace(new_tab=False),
                    model_dump=lambda **kwargs: {'navigate': {'url': origin}})])
                await self.callback(None, action, 1)
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                    urls=lambda: [origin], final_result=lambda: 'Suggested saved area: New Ashok Nagar, Delhi')

        messages = []
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome',
                   'task': 'Get my location', 'allow_location': True}
        with patch.object(worker, 'Agent', MockAgent), patch.object(worker, 'BrowserProfile'), \
             patch.object(worker, 'ChatOpenAI'), patch.object(worker, 'send', side_effect=messages.append), \
             patch.object(worker, 'location_visible_on_page', return_value=True), \
             patch.object(worker.sys, 'stdin', io.StringIO('{"allow": true}\n')), \
             patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}):
            await worker.main(request)
        grant.assert_awaited_once_with(params={'permissions': ['geolocation'], 'origin': origin})
        self.assertEqual(messages[-1]['type'], 'result')

    async def test_observed_official_email_completes_without_another_action(self):
        messages = []
        origin = 'https://benosupport.com'
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome', 'task': 'Get the official email from benosupport.com'}
        navigation = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'navigate': {'url': origin}})])
        link = SimpleNamespace(attributes={'href': 'mailto:info@benosupport.com'})
        state = SimpleNamespace(url=origin, dom_state=SimpleNamespace(selector_map={1: link}))

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']

            async def run(self, max_steps):
                await self.callback(None, navigation, 1)
                await self.callback(state, navigation, 2)
                raise AssertionError('The observed address should stop the agent')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertEqual([message['type'] for message in messages], ['status', 'approval', 'result'])
        self.assertEqual(messages[-1]['text'], f'Official email: info@benosupport.com (source: {origin})')

    async def test_done_returns_without_requesting_browser_approval(self):
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'done': {'text': 'A verified answer'}})])
        messages = []
        with patch.object(worker, 'send', side_effect=messages.append), patch.object(worker.sys, 'stdin', io.StringIO('')):
            await worker.review_action(None, output, 3, 'https://example.com')
        self.assertEqual(messages, [])

    async def test_click_review_identifies_unlabeled_element_by_visible_text(self):
        node = SimpleNamespace(node_name='DIV', attributes={}, ax_node=None, parent_node=None,
                               get_meaningful_text_for_llm=lambda: 'Delhi-NCR')
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={7: node}))
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'click': {'index': 7}})])
        messages = []
        with patch.object(worker, 'send', side_effect=messages.append), patch.object(worker.sys, 'stdin', io.StringIO('{"allow": false}\n')):
            with self.assertRaises(asyncio.CancelledError):
                await worker.review_action(state, output, 1, 'https://in.bookmyshow.com')
        self.assertEqual(json.loads(messages[0]['detail']), {'click': {'index': 7, 'element': 'div', 'label': 'Delhi-NCR', 'type': ''}})
        self.assertIs(messages[0]['routine_click'], False)

    async def test_unlabeled_icon_review_includes_its_class_and_parent(self):
        container = SimpleNamespace(node_name='DIV', attributes={'class': 'form-group ui-float-label'}, parent_node=None)
        span = SimpleNamespace(node_name='SPAN', attributes={'class': 'icn'}, parent_node=container)
        icon = SimpleNamespace(node_name='I', attributes={'class': 'fa fa-calendar'}, ax_node=None, parent_node=span,
                               get_meaningful_text_for_llm=lambda: '')
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={5: icon}))
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'click': {'index': 5}})])
        messages = []
        with patch.object(worker, 'send', side_effect=messages.append), patch.object(worker.sys, 'stdin', io.StringIO('{"allow": false}\n')):
            with self.assertRaises(asyncio.CancelledError):
                await worker.review_action(state, output, 1, 'https://www.irctc.co.in')
        detail = json.loads(messages[0]['detail'])['click']
        self.assertIn('i    fa fa-calendar span    icn', detail['context'])
        self.assertIs(messages[0]['routine_click'], False)

    async def test_captcha_handoff_replaces_stale_click_after_reply(self):
        origin = 'https://www.google.com'
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome',
                   'task': f'Inspect {origin}/recaptcha/api2/demo'}
        node = SimpleNamespace(node_name='DIV', attributes={'class': 'recaptcha-checkbox-checkmark'},
                               parent_node=None, get_meaningful_text_for_llm=lambda: '')
        state = SimpleNamespace(url=origin + '/recaptcha/api2/demo',
                                dom_state=SimpleNamespace(selector_map={5: node}))
        messages = []

        class Action:
            def __init__(self, value):
                self.value = value

            def model_dump(self, **kwargs):
                return self.value

            @classmethod
            def model_validate(cls, value):
                return cls(value)

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']
                self.step_timeout = kwargs['step_timeout']

            async def run(self, max_steps):
                navigation = SimpleNamespace(action=[Action({'navigate': {'url': origin}})])
                await self.callback(None, navigation, 1)
                proposal = SimpleNamespace(action=[Action({'click': {'index': 5}})])
                await self.callback(state, proposal, 2)
                self.assert_wait = proposal.action[0].model_dump() == {'wait': {'seconds': 1}}
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                                       urls=lambda: [origin], final_result=lambda: 'No CAPTCHA success claimed')

        instances = []
        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true}\n{"allow": true}\n')))
            patches.enter_context(patch.object(worker, 'Agent', side_effect=lambda **kwargs: instances.append(MockAgent(**kwargs)) or instances[-1]))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertTrue(instances[0].assert_wait)
        self.assertGreater(instances[0].step_timeout, 180)
        self.assertEqual([message['action'] for message in messages if message['type'] == 'approval'], ['navigate', 'captcha_handoff'])
        self.assertEqual(json.loads(messages[-2]['detail']), {'captcha_handoff': {'url': state.url}})

    async def test_captcha_handoff_denial_stops_before_click(self):
        node = SimpleNamespace(attributes={'class': 'h-captcha'}, parent_node=None,
                               get_meaningful_text_for_llm=lambda: '')
        state = SimpleNamespace(url='https://example.com', dom_state=SimpleNamespace(selector_map={5: node}))
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'click': {'index': 5}})])
        self.assertTrue(worker.captcha_action(state, output))
        messages = []
        request = {'provider': 'zai', 'origin': state.url, 'chrome': '/path/to/chrome', 'task': 'Inspect https://example.com'}

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']

            async def run(self, max_steps):
                await self.callback(state, output, 1)
                raise AssertionError('Denied CAPTCHA action must never execute')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": false}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            with self.assertRaises(asyncio.CancelledError):
                await worker.main()
        self.assertEqual(messages[-1]['action'], 'captcha_handoff')
        self.assertEqual(output.action[0].model_dump(), {'click': {'index': 5}})
        ordinary = SimpleNamespace(attributes={'class': 'search-button'}, parent_node=None,
                                   get_meaningful_text_for_llm=lambda: 'Search')
        self.assertFalse(worker.captcha_action(SimpleNamespace(dom_state=SimpleNamespace(selector_map={5: ordinary})), output))

    async def test_question_reply_continues_in_same_agent_without_finishing(self):
        origin = 'https://example.com'
        state = SimpleNamespace(url='about:blank', dom_state=SimpleNamespace(selector_map={}))
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome', 'task': 'Find a show'}
        messages = []

        class Action:
            def __init__(self, value):
                self.value = value

            def model_dump(self, **kwargs):
                return self.value

            @classmethod
            def model_validate(cls, value):
                return cls(value)

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']
                self.replies = []
                self.message_manager = SimpleNamespace(add_new_task=self.replies.append)

            async def run(self, max_steps):
                question = SimpleNamespace(action=[Action({'done': {'text': 'Which showtime do you want?'}})])
                await self.callback(state, question, 1)
                assert question.action[0].model_dump() == {'wait': {'seconds': 1}}
                assert self.replies == ['7 pm']
                await self.callback(state, SimpleNamespace(action=[Action({'done': {'text': '7 pm is available.'}})]), 2)
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                                       urls=lambda: [origin], final_result=lambda: '7 pm is available.')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true, "text": "7 pm"}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertEqual([message['action'] for message in messages if message['type'] == 'approval'], ['question_handoff'])
        self.assertEqual(json.loads(messages[1]['detail']),
                         {'question_handoff': {'question': 'Which showtime do you want?', 'url': origin}})
        self.assertEqual(messages[-1], {'type': 'result', 'text': '7 pm is available.'})

    async def test_denied_question_does_not_finish_browser_task(self):
        origin = 'https://example.com'
        state = SimpleNamespace(url=origin + '/shows', dom_state=SimpleNamespace(selector_map={}))
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome', 'task': 'Find a show'}
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs:
            {'done': {'success': False, 'text': 'Please choose a showtime to proceed.'}})])

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']

            async def run(self, max_steps):
                await self.callback(state, output, 1)
                raise AssertionError('Denied question must not finish the task')

        messages = []
        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": false}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            with self.assertRaises(asyncio.CancelledError):
                await worker.main()
        self.assertEqual(messages[-1]['action'], 'question_handoff')
        self.assertEqual(output.action[0].model_dump(), {'done': {'success': False, 'text': 'Please choose a showtime to proceed.'}})

    async def test_navigation_requires_approval_and_denial_stops_it(self):
        output = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'navigate': {'url': 'https://example.com'}})])
        messages = []
        with patch.object(worker, 'send', side_effect=messages.append), patch.object(worker.sys, 'stdin', io.StringIO('{"allow": false}\n')):
            with self.assertRaises(asyncio.CancelledError):
                await worker.review_action(None, output, 1, 'https://example.com')
        self.assertEqual(messages, [{'type': 'approval', 'step': 1, 'action': 'navigate', 'detail': json.dumps({'navigate': {'url': 'https://example.com'}}), 'origin': 'https://example.com', 'routine_click': False, 'routine_input': False}])

    async def test_clicks_only_run_without_review_for_routine_same_site_controls(self):
        def node(tag, attributes=None, parent=None, name=''):
            return SimpleNamespace(node_name=tag, attributes=attributes or {}, parent_node=parent,
                                   ax_node=SimpleNamespace(name=name))

        link = node('A', {'href': '/about'}, name='About')
        submit = node('BUTTON', {'type': 'submit'}, parent=node('FORM'), name='Continue')
        payment = node('BUTTON', {'type': 'button'}, name='Pay now')
        button = node('BUTTON', {'type': 'button'}, name='Show more')
        external = node('A', {'href': 'https://elsewhere.example/path'}, name='External')
        unknown = node('BUTTON', {'type': 'button'}, name='Continue')
        associated_form = node('BUTTON', {'type': 'button', 'form': 'checkout'}, name='Next')
        nested_link = node('SPAN', parent=link, name='About')
        format_tab = node('BUTTON', {'role': 'tab'}, name='2D')
        checkout_tab = node('BUTTON', {'role': 'tab'}, parent=node('FORM'), name='2D')
        category_tab = node('BUTTON', {'role': 'tab'}, name='Vegetarian pizzas')
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={1: link, 2: submit, 3: payment, 4: button, 5: external, 6: unknown, 7: associated_form, 8: nested_link, 9: format_tab, 10: checkout_tab, 14: category_tab}))
        for index, expected in [(1, True), (2, False), (3, False), (4, True), (5, False), (6, False), (7, False), (8, True), (9, True), (10, False), (11, False), (14, True)]:
            with self.subTest(index=index):
                self.assertEqual(worker.routine_click(state, {'click': {'index': index}}, 'https://example.com'), expected)
        city = node('LI')
        city.get_meaningful_text_for_llm = lambda: 'Delhi-NCR'
        state.dom_state.selector_map[12] = city
        self.assertTrue(worker.routine_click(state, {'click': {'index': 12}}, 'https://in.bookmyshow.com'))
        self.assertFalse(worker.routine_click(state, {'click': {'index': 12}}, 'https://example.com'))
        search = node('DIV')
        search.get_meaningful_text_for_llm = lambda: 'Search for Movies, Events, Plays, Sports and Activities'
        state.dom_state.selector_map[13] = search
        self.assertTrue(worker.routine_click(state, {'click': {'index': 13}}, 'https://in.bookmyshow.com'))
        self.assertFalse(worker.routine_click(state, {'click': {'index': 13}}, 'https://example.com'))

    async def test_irctc_train_search_dropdowns_are_routine_but_submissions_are_not(self):
        def node(tag, attributes=None, parent=None, name=''):
            return SimpleNamespace(node_name=tag, attributes=attributes or {}, parent_node=parent,
                                   ax_node=SimpleNamespace(name=name))

        form = node('FORM')
        train_class = node('P-DROPDOWN', {'id': 'journeyClass'}, form)
        quota = node('P-DROPDOWN', {'id': 'journeyQuota'}, form)
        payment = node('P-DROPDOWN', {'id': 'paymentMethod'}, form)
        class_panel = node('DIV', {'class': 'ui-dropdown-panel'}, node('DIV', parent=train_class))
        class_options = node('UL', {'role': 'listbox', 'class': 'ui-dropdown-items'}, node('DIV', parent=class_panel))
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={
            1: node('SPAN', {'class': 'ui-dropdown-label'}, node('DIV', parent=node('DIV', parent=train_class)), 'All Classes'),
            2: node('DIV', {'class': 'ui-dropdown-trigger', 'role': 'button'}, node('DIV', parent=quota)),
            3: node('SPAN', parent=node('DIV', parent=payment), name='Card'),
            4: node('BUTTON', {'type': 'submit'}, form, 'Search Trains'),
            5: node('SPAN', parent=node('DIV', {'class': 'checkout'}, train_class), name='All Classes'),
            6: node('LI', {'role': 'option', 'class': 'ui-dropdown-item'}, node('P-DROPDOWNITEM', parent=class_options), 'Sleeper (SL)'),
            7: node('LI', {'role': 'option', 'class': 'ui-dropdown-item'}, node('P-DROPDOWNITEM', parent=node('UL', parent=payment)), 'Pay with card'),
        }))
        for index, allowed in [(1, True), (2, True), (3, False), (4, False), (5, False), (6, True), (7, False)]:
            with self.subTest(index=index):
                self.assertEqual(worker.routine_click(state, {'click': {'index': index}}, 'https://www.irctc.co.in'), allowed)
        self.assertFalse(worker.routine_click(state, {'click': {'index': 1}}, 'https://example.com'))

    async def test_irctc_station_suggestions_only_allow_coded_options(self):
        def node(tag, attributes=None, parent=None, name=''):
            return SimpleNamespace(node_name=tag, attributes=attributes or {}, parent_node=parent,
                                   ax_node=SimpleNamespace(name=name), get_meaningful_text_for_llm=lambda: name)

        form = node('FORM')
        origin = node('P-AUTOCOMPLETE', {'id': 'origin'}, form)
        wrapper = node('SPAN', {'class': 'ui-autocomplete'}, origin)
        panel = node('DIV', {'class': 'ui-autocomplete-panel'}, wrapper)
        listbox = node('UL', {'role': 'listbox', 'class': 'ui-autocomplete-items'}, panel)
        station = node('LI', {'role': 'option', 'class': 'ui-autocomplete-list-item'}, listbox, 'NEW DELHI - NDLS (NEW DELHI) DELHI')
        header = node('LI', {'role': 'option', 'class': 'ui-autocomplete-list-item'}, listbox, '----- Stations -----')
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={
            1: station, 2: node('STRONG', parent=node('DIV', parent=station)), 3: header,
            4: node('LI', {'role': 'option', 'class': 'ui-autocomplete-list-item'}, node('UL', parent=node('DIV', parent=node('P-AUTOCOMPLETE', {'id': 'address'}))), 'NEW DELHI - NDLS'),
        }))
        for index, allowed in [(1, True), (2, True), (3, False), (4, False)]:
            with self.subTest(index=index):
                self.assertEqual(worker.routine_click(state, {'click': {'index': index}}, 'https://www.irctc.co.in'), allowed)
        self.assertFalse(worker.routine_click(state, {'click': {'index': 1}}, 'https://example.com'))

    async def test_bookmyshow_navigation_stops_at_exact_seat_and_checkout(self):
        def node(tag, name, parent=None, attributes=None):
            return SimpleNamespace(node_name=tag, attributes=attributes or {}, parent_node=parent,
                                   ax_node=SimpleNamespace(name=name), get_meaningful_text_for_llm=lambda: name)

        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={
            1: node('BUTTON', 'Book 05:25 PM'), 2: node('BUTTON', 'Pay now'),
            3: node('DIV', 'A12'), 4: node('A', 'B3', attributes={'href': '/seats'}),
            5: node('BUTTON', 'Show times'), 6: node('LI', 'Noida'),
            7: node('BUTTON', 'Book 05:25 PM', parent=node('FORM', 'Checkout')),
        }))
        for index, allowed in [(1, True), (2, False), (3, False), (4, False), (5, True), (6, True), (7, False)]:
            with self.subTest(index=index):
                self.assertEqual(worker.routine_click(state, {'click': {'index': index}}, 'https://in.bookmyshow.com'), allowed)

    async def test_bookmyshow_keyboard_and_dropdown_only_auto_allow_navigation(self):
        def node(tag, attributes=None, parent=None):
            return SimpleNamespace(node_name=tag, attributes=attributes or {}, parent_node=parent)

        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={
            1: node('SELECT', {'name': 'language'}),
            2: node('SELECT', {'name': 'card'}),
            3: node('SELECT', {'name': 'cinema'}, node('FORM')),
        }))
        for keys, allowed in [('Escape', True), ('ArrowDown', True), ('Enter', False), ('Control+a', False)]:
            self.assertEqual(worker.routine_navigation(state, {'send_keys': {'keys': keys}}, 'https://in.bookmyshow.com'), allowed)
        for index, allowed in [(1, True), (2, False), (3, False)]:
            self.assertEqual(worker.routine_navigation(state, {'select_dropdown_option': {'index': index, 'text': 'Hindi'}}, 'https://in.bookmyshow.com'), allowed)
        self.assertFalse(worker.routine_navigation(state, {'send_keys': {'keys': 'Tab'}}, 'https://example.com'))

    async def test_only_search_field_queries_count_as_routine_typing(self):
        def field(attributes):
            return SimpleNamespace(node_name='INPUT', attributes=attributes)

        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={
            1: field({'type': 'search', 'name': 'site-search'}),
            2: field({'type': 'text', 'name': 'email'}),
            3: field({'type': 'password'}),
            4: field({'type': 'search', 'name': 'contact-email'}),
            5: field({'type': 'text', 'role': 'searchbox'}),
        }))
        for index, text, expected in [(1, 'pricing', True), (5, 'about us', True), (2, 'hello', False),
                                      (3, 'secret', False), (4, 'hello', False), (1, 'hello@example.com', False),
                                      (1, '1234567890', False), (1, 'buy\nsubmit', False), (6, 'pricing', False)]:
            with self.subTest(index=index, text=text):
                self.assertEqual(worker.routine_input(state, {'input': {'index': index, 'text': text}}), expected)
        container = SimpleNamespace(attributes={'class': 'sc-10a0gyl-1 jKgMno'})
        overlay = SimpleNamespace(attributes={'class': 'sc-10a0gyl-4 hmhRsf'}, parent_node=container)
        state.dom_state.selector_map[7] = SimpleNamespace(node_name='INPUT', attributes={'type': 'text'}, parent_node=overlay)
        self.assertTrue(worker.routine_input(state, {'input': {'index': 7, 'text': 'Mirzapur'}}, 'https://in.bookmyshow.com'))
        self.assertFalse(worker.routine_input(state, {'input': {'index': 7, 'text': 'Mirzapur'}}, 'https://example.com'))
        self.assertFalse(worker.routine_input(state, {'input': {'index': 7, 'text': 'test@example.com'}}, 'https://in.bookmyshow.com'))

    async def test_contact_fields_request_real_values_before_input(self):
        field = SimpleNamespace(node_name='INPUT', attributes={'type': 'email', 'name': 'email'},
                                ax_node=SimpleNamespace(name='Email'), parent_node=None)
        state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={1: field}))
        action = SimpleNamespace(input=SimpleNamespace(text='invented@example.com'),
                                 model_dump=lambda **kwargs: {'input': {'index': 1, 'text': 'invented@example.com'}})
        messages = []
        output = SimpleNamespace(action=[action])
        with patch.object(worker, 'send', side_effect=messages.append), patch.object(worker.sys, 'stdin', io.StringIO('{"allow": true, "text": "real@example.com"}\n')):
            await worker.review_action(state, output, 1, 'https://example.com')
        self.assertEqual(messages[0]['field'], 'email')
        self.assertEqual(action.input.text, 'real@example.com')
        field.attributes = {'type': 'password', 'name': 'password'}
        self.assertIsNone(worker.contact_field(state, {'input': {'index': 1, 'text': 'secret'}}))
        field.attributes = {'type': 'email', 'name': 'email'}
        field.parent_node = SimpleNamespace(node_name='FORM', attributes={'id': 'account-login'}, parent_node=None)
        self.assertIsNone(worker.contact_field(state, {'input': {'index': 1, 'text': 'guess@example.com'}}))

    async def test_approved_visit_returns_answer_without_done_approval(self):
        messages = []
        request = {'provider': 'zai', 'origin': 'https://example.com', 'chrome': '/path/to/chrome', 'task': 'Find the contact email'}
        navigation = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'navigate': {'url': 'https://example.com'}})])
        done = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'done': {'text': 'Contact: hello@example.com', 'success': True}})])

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']
                self.task = kwargs['task']
                self.assert_task(self.task)

            def assert_task(self, task):
                assert 'read the page text and mailto links first' in task

            async def run(self, max_steps):
                await self.callback(None, navigation, 1)
                await self.callback(None, done, 2)
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                                       urls=lambda: ['https://example.com/contact'], final_result=lambda: 'Contact: hello@example.com')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertEqual([message['type'] for message in messages], ['status', 'approval', 'result'])
        self.assertIs(messages[1]['routine_click'], False)
        self.assertIs(messages[1]['routine_input'], False)
        self.assertEqual(messages[-1]['text'], 'Contact: hello@example.com')

    async def test_unfinished_run_reports_step_budget_instead_of_generic_value_error(self):
        request = {'provider': 'zai', 'origin': 'https://example.com', 'chrome': '/path/to/chrome', 'task': 'Find tickets'}
        messages = []
        session = SimpleNamespace(kill=lambda: asyncio.sleep(0))

        class MockAgent:
            def __init__(self, **kwargs):
                self.browser_session = session

            async def run(self, max_steps):
                self_max_steps.append(max_steps)
                return SimpleNamespace(is_done=lambda: False, is_successful=lambda: False)

        self_max_steps = []
        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile'))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            with self.assertRaisesRegex(worker.TaskIncomplete, 'after 40 steps'):
                await worker.main()
        self.assertEqual(self_max_steps, [40])

    async def test_unsuccessful_done_preserves_reason_and_chrome_session(self):
        session = SimpleNamespace(kill=AsyncMock())

        class MockAgent:
            def __init__(self, **kwargs):
                self.browser_session = session

            async def run(self, max_steps):
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: False,
                                       final_result=lambda: 'Delivery address is missing')

        request = {'provider': 'zai', 'origin': 'https://example.com', 'chrome': '/path/to/chrome', 'task': 'Order pizza'}
        with patch.object(worker, 'Agent', MockAgent), patch.object(worker, 'BrowserProfile'), \
             patch.object(worker, 'ChatOpenAI'), patch.object(worker, 'send'), \
             patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}):
            with self.assertRaisesRegex(worker.TaskIncomplete, 'Delivery address is missing') as failure:
                await worker.main(request)
        self.assertIs(failure.exception.session, session)
        session.kill.assert_not_called()

    async def test_incomplete_run_without_chrome_cannot_be_reused(self):
        class MockAgent:
            def __init__(self, **kwargs):
                self.browser_session = None

            async def run(self, max_steps):
                return SimpleNamespace(is_done=lambda: False)

        request = {'provider': 'zai', 'origin': 'https://example.com', 'chrome': '/path/to/chrome', 'task': 'inspect'}
        with patch.object(worker, 'Agent', MockAgent), patch.object(worker, 'BrowserProfile'), \
             patch.object(worker, 'ChatOpenAI'), patch.object(worker, 'send'), \
             patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}):
            with self.assertRaisesRegex(ValueError, 'No Chrome session is available'):
                await worker.main(request)

    async def test_pizza_order_waits_for_payment_handoff_before_reporting(self):
        origin = 'https://pizzaonline.dominos.co.in'
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome',
                   'task': f'At {origin}, start a delivery order for two large pizzas'}
        navigation = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'navigate': {'url': origin}})])
        profiles = []
        messages = []

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']

            async def run(self, max_steps):
                await self.callback(None, navigation, 1)
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                                       urls=lambda: [origin], final_result=lambda: 'Checkout displayed; payment not verified')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true}\n{"allow": true}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile', side_effect=lambda **kwargs: profiles.append(kwargs) or kwargs))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertTrue(profiles[0]['keep_alive'])
        self.assertEqual([message['type'] for message in messages], ['status', 'approval', 'approval', 'result'])
        self.assertEqual(messages[-2]['action'], 'payment_handoff')
        self.assertIn('not verified', messages[-1]['text'])

    async def test_ticket_order_keeps_chrome_open_for_user_payment(self):
        origin = 'https://in.bookmyshow.com'
        request = {'provider': 'zai', 'origin': origin, 'chrome': '/path/to/chrome',
                   'task': 'book cheapest ticket of Mirzapur in Noida for one seat'}
        navigation = SimpleNamespace(action=[SimpleNamespace(model_dump=lambda **kwargs: {'navigate': {'url': origin}})])
        profiles = []
        messages = []

        class MockAgent:
            def __init__(self, **kwargs):
                self.callback = kwargs['register_new_step_callback']

            async def run(self, max_steps):
                await self.callback(None, navigation, 1)
                return SimpleNamespace(is_done=lambda: True, is_successful=lambda: True,
                                       urls=lambda: [origin], final_result=lambda: 'Seats shown; payment not verified')

        with ExitStack() as patches:
            patches.enter_context(patch.object(worker, 'send', side_effect=messages.append))
            patches.enter_context(patch.object(worker.sys, 'stdin', io.StringIO(json.dumps(request) + '\n{"allow": true}\n{"allow": true}\n')))
            patches.enter_context(patch.object(worker, 'Agent', MockAgent))
            patches.enter_context(patch.object(worker, 'BrowserProfile', side_effect=lambda **kwargs: profiles.append(kwargs) or kwargs))
            patches.enter_context(patch.object(worker, 'ChatOpenAI'))
            patches.enter_context(patch.dict(worker.os.environ, {'JARVIS_BROWSER_KEY': 'test-key'}))
            await worker.main()
        self.assertTrue(profiles[0]['keep_alive'])
        self.assertEqual([message['type'] for message in messages], ['status', 'approval', 'approval', 'result'])
        self.assertEqual(messages[-2]['action'], 'payment_handoff')


if __name__ == '__main__':
    unittest.main()